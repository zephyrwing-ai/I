import { VOICE_TRANSCRIPTION_MAX_AUDIO_BYTES } from "../../../../shell/shared/ipc";

const WAV_HEADER_BYTES = 44;

export const VOICE_SAMPLE_RATE = 16_000;
export const VOICE_MAX_SAMPLES = Math.floor(
  (VOICE_TRANSCRIPTION_MAX_AUDIO_BYTES - WAV_HEADER_BYTES) / Int16Array.BYTES_PER_ELEMENT,
);

export type VoicePhase = "idle" | "requesting" | "recording" | "transcribing";

export interface VoiceState {
  phase: VoicePhase;
  error: string | null;
}

export const INITIAL_VOICE_STATE: VoiceState = {
  phase: "idle",
  error: null,
};

export function voiceButtonLabel(phase: VoicePhase): string {
  if (phase === "requesting" || phase === "transcribing") return "Cancel voice input";
  if (phase === "recording") return "Stop voice input";
  return "Start voice input";
}

export function canStartVoiceInput({
  ready,
  running,
  submitting,
  phase,
}: {
  ready: boolean;
  running: boolean;
  submitting: boolean;
  phase: VoicePhase;
}): boolean {
  return ready && !running && !submitting && phase === "idle";
}

export function appendVoiceTranscript(current: string, transcript: string): string {
  const spoken = transcript.trim();
  if (!spoken) return current;
  const separator = current && !current.endsWith("\n") ? "\n" : "";
  return `${current}${separator}${spoken}`;
}

export function microphoneErrorMessage(error: unknown): string {
  const name = error && typeof error === "object" && "name" in error
    ? String((error as { name?: unknown }).name)
    : "";
  if (name === "NotAllowedError" || name === "SecurityError") {
    return "Microphone access is blocked. Allow it in System Settings, then retry.";
  }
  if (name === "NotFoundError" || name === "DevicesNotFoundError") {
    return "No microphone is available. Connect one and retry.";
  }
  if (name === "NotReadableError" || name === "TrackStartError") {
    return "The microphone is busy in another app. Close it and retry.";
  }
  return "Microphone access failed. Check the device and retry.";
}

export function encodePcm16SamplesWav(samples: Int16Array, sampleRate = VOICE_SAMPLE_RATE): ArrayBuffer {
  const dataBytes = samples.length * 2;
  const buffer = new ArrayBuffer(WAV_HEADER_BYTES + dataBytes);
  const view = new DataView(buffer);
  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, dataBytes, true);
  new Uint8Array(buffer, WAV_HEADER_BYTES).set(new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength));
  return buffer;
}

export function downsamplePcm(input: Float32Array, inputRate: number, outputRate = VOICE_SAMPLE_RATE): Float32Array {
  if (inputRate === outputRate) return input;
  if (input.length === 0) return input;
  const ratio = inputRate / outputRate;
  const outputLength = Math.max(1, Math.round(input.length / ratio));
  const output = new Float32Array(outputLength);
  for (let index = 0; index < outputLength; index += 1) {
    const start = Math.min(input.length - 1, Math.floor(index * ratio));
    const end = Math.min(input.length, Math.max(start + 1, Math.ceil((index + 1) * ratio)));
    let sum = 0;
    for (let source = start; source < end; source += 1) sum += input[source];
    output[index] = sum / Math.max(1, end - start);
  }
  return output;
}

function writeAscii(view: DataView, offset: number, value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    view.setUint8(offset + index, value.charCodeAt(index));
  }
}
