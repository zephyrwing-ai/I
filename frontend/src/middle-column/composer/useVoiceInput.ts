import { useCallback, useEffect, useRef, useState } from "react";
import {
  VOICE_MAX_SAMPLES,
  VOICE_MAX_SEGMENT_SAMPLES,
  VOICE_SAMPLE_RATE,
  canStartVoiceInput,
  downsamplePcm,
  encodePcm16SamplesWav,
  microphoneErrorMessage,
  updateVoiceSegmentBoundary,
  type VoiceState,
  type VoiceSegmentBoundary,
  INITIAL_VOICE_STATE,
} from "./voice";

interface VoiceScope {
  key: string | null;
}

interface PendingCapture {
  recordingId: string;
  scope: VoiceScope;
  stream: MediaStream | null;
  context: AudioContext | null;
}

interface RecordingSession {
  recordingId: string;
  scope: VoiceScope;
  stream: MediaStream;
  context: AudioContext;
  source: MediaStreamAudioSourceNode;
  analyser: AnalyserNode;
  processor: ScriptProcessorNode;
  segment: Int16Array;
  segmentSamples: number;
  totalSamples: number;
  nextSegmentId: number;
}

interface UseVoiceInputOptions {
  ready: boolean;
  running: boolean;
  submitting: boolean;
  scopeKey: string | null;
  onTranscript: (text: string) => void;
}

interface UseVoiceInputResult {
  state: VoiceState;
  analyser: AnalyserNode | null;
  start: () => Promise<void>;
  stop: () => void;
  cancel: () => void;
  dismissError: () => void;
}

export function useVoiceInput({
  ready,
  running,
  submitting,
  scopeKey,
  onTranscript,
}: UseVoiceInputOptions): UseVoiceInputResult {
  const [state, setState] = useState<VoiceState>(INITIAL_VOICE_STATE);
  const [analyser, setAnalyser] = useState<AnalyserNode | null>(null);
  const pendingCaptureRef = useRef<PendingCapture | null>(null);
  const sessionRef = useRef<RecordingSession | null>(null);
  const mountedRef = useRef(true);
  const transcriptRef = useRef(onTranscript);
  transcriptRef.current = onTranscript;
  const activeScope = useRef<VoiceScope>({ key: scopeKey });
  if (activeScope.current.key !== scopeKey) activeScope.current = { key: scopeKey };
  const boundaryRef = useRef<VoiceSegmentBoundary>({ speechMs: 0, silenceMs: 0, close: false });
  const completedRef = useRef(new Map<number, string>());
  const pendingRef = useRef(new Map<number, Promise<void>>());
  const nextAppendIdRef = useRef(0);
  const cancelledRef = useRef(false);
  const failureRef = useRef<string | null>(null);
  const recordingRef = useRef<string | null>(null);
  const runRef = useRef({
    closeSegment: (_session: RecordingSession): void => undefined,
    failSession: (_session: RecordingSession, _message: string): void => undefined,
    endSession: (_session: RecordingSession, _cancelled: boolean): void => undefined,
  });

  const setMountedState = useCallback((next: VoiceState | ((current: VoiceState) => VoiceState)): void => {
    if (mountedRef.current) setState(next);
  }, []);
  const setMountedAnalyser = useCallback((next: AnalyserNode | null): void => {
    if (mountedRef.current) setAnalyser(next);
  }, []);

  const releaseSession = useCallback((session: RecordingSession): void => {
    session.processor.onaudioprocess = null;
    session.analyser.disconnect();
    session.processor.disconnect();
    session.source.disconnect();
    for (const track of session.stream.getTracks()) {
      track.onended = null;
      track.stop();
    }
    void session.context.close().catch(() => undefined);
  }, []);

  const flushCompleted = (): void => {
    while (completedRef.current.has(nextAppendIdRef.current)) {
      const text = completedRef.current.get(nextAppendIdRef.current) ?? "";
      completedRef.current.delete(nextAppendIdRef.current);
      nextAppendIdRef.current += 1;
      if (text.trim()) transcriptRef.current(text);
    }
  };

  const dispatchSegment = (session: RecordingSession): void => {
    if (session.segmentSamples === 0) return;
    const samples = session.segment.slice(0, session.segmentSamples);
    session.segment.fill(0);
    session.segmentSamples = 0;
    const audio = encodePcm16SamplesWav(samples);
    const segmentId = session.nextSegmentId;
    session.nextSegmentId += 1;
    const task = (async (): Promise<void> => {
      try {
        const result = await window.agentAPI.transcribeVoiceSegment({
          recordingId: session.recordingId,
          segmentId,
          audio,
        });
        if (cancelledRef.current || activeScope.current !== session.scope) return;
        if (!result.ok) {
          runRef.current.failSession(session, result.message);
          return;
        }
        completedRef.current.set(segmentId, result.text);
        flushCompleted();
      } catch (error) {
        if (cancelledRef.current || activeScope.current !== session.scope) return;
        runRef.current.failSession(
          session,
          error instanceof Error ? error.message : "Voice transcription failed. Retry.",
        );
      }
    })();
    pendingRef.current.set(segmentId, task);
    void task.finally(() => pendingRef.current.delete(segmentId));
  };

  const closeSegment = (session: RecordingSession): void => {
    dispatchSegment(session);
    boundaryRef.current = { speechMs: 0, silenceMs: 0, close: false };
  };

  const settleSession = (session: RecordingSession, message: string | null): void => {
    if (!mountedRef.current) return;
    if (cancelledRef.current || activeScope.current !== session.scope) return;
    if (recordingRef.current === session.recordingId) recordingRef.current = null;
    flushCompleted();
    setMountedState(message ? { phase: "idle", error: message } : INITIAL_VOICE_STATE);
  };

  const failSession = (session: RecordingSession, message: string): void => {
    if (sessionRef.current !== session) return;
    failureRef.current = failureRef.current ?? message;
    window.agentAPI.cancelVoiceRecording(session.recordingId);
    sessionRef.current = null;
    releaseSession(session);
    setMountedAnalyser(null);
    setMountedState({ phase: "transcribing", error: null });
    void (async () => {
      await Promise.allSettled([...pendingRef.current.values()]);
      settleSession(session, failureRef.current);
    })();
  };

  const endSession = (session: RecordingSession, cancelled: boolean): void => {
    if (sessionRef.current !== session) return;
    sessionRef.current = null;
    if (!cancelled) closeSegment(session);
    releaseSession(session);
    setMountedAnalyser(null);
    if (cancelled) {
      setMountedState(INITIAL_VOICE_STATE);
      return;
    }
    setMountedState({ phase: "transcribing", error: null });
    void (async () => {
      await Promise.allSettled([...pendingRef.current.values()]);
      settleSession(session, failureRef.current);
    })();
  };
  runRef.current = { closeSegment, failSession, endSession };

  const start = useCallback(async (): Promise<void> => {
    if (!canStartVoiceInput({ ready, running, submitting, phase: state.phase })
      || pendingCaptureRef.current
      || sessionRef.current) return;
    setMountedState({ phase: "requesting", error: null });
    const pending: PendingCapture = {
      recordingId: crypto.randomUUID(),
      scope: activeScope.current,
      stream: null,
      context: null,
    };
    pendingCaptureRef.current = pending;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false,
      });
      if (!mountedRef.current || pendingCaptureRef.current !== pending || activeScope.current !== pending.scope) {
        for (const track of stream.getTracks()) track.stop();
        return;
      }
      pending.stream = stream;
      const audioContext = new AudioContext({ sampleRate: VOICE_SAMPLE_RATE });
      pending.context = audioContext;
      await audioContext.resume();
      if (!mountedRef.current || pendingCaptureRef.current !== pending || activeScope.current !== pending.scope) {
        releasePendingCapture(pending);
        return;
      }
      const source = audioContext.createMediaStreamSource(stream);
      const processor = audioContext.createScriptProcessor(4096, 1, 1);
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 2048;
      const session: RecordingSession = {
        recordingId: pending.recordingId,
        scope: pending.scope,
        stream,
        context: audioContext,
        source,
        analyser,
        processor,
        segment: new Int16Array(VOICE_MAX_SEGMENT_SAMPLES),
        segmentSamples: 0,
        totalSamples: 0,
        nextSegmentId: 0,
      };
      boundaryRef.current = { speechMs: 0, silenceMs: 0, close: false };
      completedRef.current = new Map();
      pendingRef.current = new Map();
      nextAppendIdRef.current = 0;
      cancelledRef.current = false;
      failureRef.current = null;
      recordingRef.current = pending.recordingId;

      processor.onaudioprocess = (event) => {
        if (sessionRef.current !== session || activeScope.current !== session.scope) return;
        const input = event.inputBuffer.getChannelData(0);
        const downsampled = downsamplePcm(input, audioContext.sampleRate, VOICE_SAMPLE_RATE);
        const writable = Math.min(downsampled.length, VOICE_MAX_SEGMENT_SAMPLES - session.segmentSamples);
        for (let index = 0; index < writable; index += 1) {
          const sample = Math.max(-1, Math.min(1, downsampled[index]));
          session.segment[session.segmentSamples + index] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
        }
        session.segmentSamples += writable;
        session.totalSamples += writable;
        if (session.totalSamples >= VOICE_MAX_SAMPLES) {
          runRef.current.endSession(session, false);
          return;
        }
        boundaryRef.current = updateVoiceSegmentBoundary(
          boundaryRef.current,
          downsampled.subarray(0, writable),
          VOICE_SAMPLE_RATE,
        );
        if (boundaryRef.current.close) runRef.current.closeSegment(session);
        if (session.segmentSamples >= VOICE_MAX_SEGMENT_SAMPLES) runRef.current.closeSegment(session);
      };
      source.connect(analyser);
      analyser.connect(processor);
      processor.connect(audioContext.destination);
      pendingCaptureRef.current = null;
      sessionRef.current = session;
      for (const track of stream.getAudioTracks()) {
        track.onended = () => {
          if (sessionRef.current !== session || activeScope.current !== session.scope) return;
          sessionRef.current = null;
          releaseSession(session);
          setMountedAnalyser(null);
          setMountedState({ phase: "idle", error: "The microphone disconnected. Connect it and record again." });
        };
      }
      setMountedAnalyser(analyser);
      setMountedState({ phase: "recording", error: null });
    } catch (error) {
      if (pendingCaptureRef.current !== pending) return;
      pendingCaptureRef.current = null;
      releasePendingCapture(pending);
      if (activeScope.current !== pending.scope) return;
      setMountedAnalyser(null);
      setMountedState({
        phase: "idle",
        error: microphoneErrorMessage(error),
      });
    }
  }, [ready, releaseSession, running, setMountedAnalyser, setMountedState, state.phase, submitting]);

  const stop = useCallback((): void => {
    const session = sessionRef.current;
    if (session) runRef.current.endSession(session, false);
  }, []);

  const cancel = useCallback((): void => {
    const pending = pendingCaptureRef.current;
    pendingCaptureRef.current = null;
    if (pending) releasePendingCapture(pending);
    const session = sessionRef.current;
    if (session) {
      cancelledRef.current = true;
      window.agentAPI.cancelVoiceRecording(session.recordingId);
      recordingRef.current = null;
      runRef.current.endSession(session, true);
      return;
    }
    if (recordingRef.current) {
      window.agentAPI.cancelVoiceRecording(recordingRef.current);
      recordingRef.current = null;
      cancelledRef.current = true;
    }
    setMountedAnalyser(null);
    setMountedState(INITIAL_VOICE_STATE);
  }, [releaseSession, setMountedAnalyser, setMountedState]);

  const dismissError = useCallback((): void => {
    setMountedState((current) => current.error ? { ...current, error: null } : current);
  }, [setMountedState]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      cancel();
    };
  }, [cancel]);

  useEffect(() => {
    if (running || !ready) cancel();
  }, [cancel, ready, running]);

  useEffect(() => cancel, [cancel, scopeKey]);

  return { state, analyser, start, stop, cancel, dismissError };
}

function releasePendingCapture(pending: PendingCapture): void {
  for (const track of pending.stream?.getTracks() ?? []) track.stop();
  if (pending.context) void pending.context.close().catch(() => undefined);
}
