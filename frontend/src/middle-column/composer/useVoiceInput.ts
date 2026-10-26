import { useCallback, useEffect, useRef, useState } from "react";
import {
  VOICE_MAX_SAMPLES,
  VOICE_SAMPLE_RATE,
  canStartVoiceInput,
  downsamplePcm,
  encodePcm16SamplesWav,
  microphoneErrorMessage,
  type VoiceState,
  INITIAL_VOICE_STATE,
} from "./voice";

interface VoiceScope {
  key: string | null;
}

interface PendingCapture {
  requestId: string;
  scope: VoiceScope;
  stream: MediaStream | null;
  context: AudioContext | null;
}

interface RecordingSession {
  requestId: string;
  scope: VoiceScope;
  stream: MediaStream;
  context: AudioContext;
  source: MediaStreamAudioSourceNode;
  analyser: AnalyserNode;
  processor: ScriptProcessorNode;
  pcm: Int16Array;
  totalSamples: number;
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
  const transcriptionRequestRef = useRef<string | null>(null);
  const mountedRef = useRef(true);
  const transcriptRef = useRef(onTranscript);
  transcriptRef.current = onTranscript;
  const activeScope = useRef<VoiceScope>({ key: scopeKey });
  if (activeScope.current.key !== scopeKey) activeScope.current = { key: scopeKey };

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

  const finishRecording = useCallback(async (session: RecordingSession, cancelled: boolean): Promise<void> => {
    if (sessionRef.current !== session) return;
    sessionRef.current = null;
    releaseSession(session);
    setMountedAnalyser(null);
    if (cancelled || activeScope.current !== session.scope) {
      setMountedState(INITIAL_VOICE_STATE);
      return;
    }
    if (session.totalSamples === 0) {
      setMountedState({ phase: "idle", error: "No audio was recorded. Record again and retry." });
      return;
    }
    if (session.totalSamples > VOICE_MAX_SAMPLES) {
      setMountedState({ phase: "idle", error: "The recording exceeds the 20 MiB limit." });
      return;
    }
    const samples = session.pcm.slice(0, session.totalSamples);
    session.pcm = new Int16Array(0);
    const audio = encodePcm16SamplesWav(samples);
    transcriptionRequestRef.current = session.requestId;
    setMountedState({ phase: "transcribing", error: null });
    try {
      const result = await window.agentAPI.transcribeVoice({ requestId: session.requestId, audio });
      if (transcriptionRequestRef.current !== session.requestId) return;
      transcriptionRequestRef.current = null;
      if (!mountedRef.current || activeScope.current !== session.scope) return;
      if (!result.ok) {
        setMountedState({ phase: "idle", error: result.message });
        return;
      }
      transcriptRef.current(result.text);
      setMountedState(INITIAL_VOICE_STATE);
    } catch (error) {
      if (transcriptionRequestRef.current !== session.requestId) return;
      transcriptionRequestRef.current = null;
      if (!mountedRef.current || activeScope.current !== session.scope) return;
      setMountedState({
        phase: "idle",
        error: error instanceof Error ? error.message : "Voice transcription failed. Retry.",
      });
    }
  }, [releaseSession, setMountedAnalyser, setMountedState]);

  const start = useCallback(async (): Promise<void> => {
    if (!canStartVoiceInput({ ready, running, submitting, phase: state.phase })
      || pendingCaptureRef.current
      || sessionRef.current
      || transcriptionRequestRef.current) return;
    setMountedState({ phase: "requesting", error: null });
    const pending: PendingCapture = { requestId: crypto.randomUUID(), scope: activeScope.current, stream: null, context: null };
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
        requestId: pending.requestId,
        scope: pending.scope,
        stream,
        context: audioContext,
        source,
        analyser,
        processor,
        pcm: new Int16Array(VOICE_MAX_SAMPLES),
        totalSamples: 0,
      };
      processor.onaudioprocess = (event) => {
        if (sessionRef.current !== session || activeScope.current !== session.scope) return;
        const input = event.inputBuffer.getChannelData(0);
        const downsampled = downsamplePcm(input, audioContext.sampleRate, VOICE_SAMPLE_RATE);
        const writable = Math.min(downsampled.length, VOICE_MAX_SAMPLES - session.totalSamples);
        for (let index = 0; index < writable; index += 1) {
          const sample = Math.max(-1, Math.min(1, downsampled[index]));
          session.pcm[session.totalSamples + index] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
        }
        session.totalSamples += writable;
        if (session.totalSamples >= VOICE_MAX_SAMPLES) {
          void finishRecording(session, false);
        }
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
  }, [finishRecording, ready, releaseSession, running, setMountedAnalyser, setMountedState, state.phase, submitting]);

  const stop = useCallback((): void => {
    const session = sessionRef.current;
    if (session) void finishRecording(session, false);
  }, [finishRecording]);

  const cancel = useCallback((): void => {
    const pending = pendingCaptureRef.current;
    pendingCaptureRef.current = null;
    if (pending) releasePendingCapture(pending);
    const session = sessionRef.current;
    if (session) {
      void finishRecording(session, true);
      return;
    }
    if (transcriptionRequestRef.current) {
      const requestId = transcriptionRequestRef.current;
      transcriptionRequestRef.current = null;
      window.agentAPI.cancelVoiceTranscription(requestId);
    }
    setMountedAnalyser(null);
    setMountedState(INITIAL_VOICE_STATE);
  }, [finishRecording, setMountedAnalyser, setMountedState]);

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
