import assert from "node:assert/strict";
import test from "node:test";
import { VOICE_TRANSCRIPTION_MAX_AUDIO_BYTES } from "../../../../../shell/shared/ipc.js";

const {
  VOICE_MAX_SAMPLES,
  VOICE_SAMPLE_RATE,
  appendVoiceTranscript,
  canStartVoiceInput,
  downsamplePcm,
  encodePcm16SamplesWav,
  microphoneErrorMessage,
  voiceButtonLabel,
} = await import("../../../../../frontend/src/middle-column/composer/voice.js");

function ascii(view: DataView, offset: number, length: number): string {
  return Array.from({ length }, (_, index) => String.fromCharCode(view.getUint8(offset + index))).join("");
}

test("voice sample capacity fits the shared 20 MiB WAV budget including the header", () => {
  assert.equal(VOICE_TRANSCRIPTION_MAX_AUDIO_BYTES, 20 * 1024 * 1024);
  assert.equal(VOICE_SAMPLE_RATE, 16_000);
  const samples = new Int16Array(VOICE_MAX_SAMPLES + 1);
  samples[0] = -32768;
  samples[VOICE_MAX_SAMPLES - 1] = 32767;
  for (const sampleCount of [VOICE_MAX_SAMPLES - 1, VOICE_MAX_SAMPLES, VOICE_MAX_SAMPLES + 1]) {
    const audio = encodePcm16SamplesWav(samples.subarray(0, sampleCount));
    assert.equal(audio.byteLength, VOICE_TRANSCRIPTION_MAX_AUDIO_BYTES + (sampleCount - VOICE_MAX_SAMPLES) * 2);
    assert.equal(audio.byteLength <= VOICE_TRANSCRIPTION_MAX_AUDIO_BYTES, sampleCount <= VOICE_MAX_SAMPLES);
    const view = new DataView(audio);
    assert.equal(view.getUint32(4, true), audio.byteLength - 8);
    assert.equal(view.getUint32(40, true), sampleCount * 2);
    assert.equal(view.getInt16(44, true), -32768);
    if (sampleCount >= VOICE_MAX_SAMPLES) {
      assert.equal(view.getInt16(44 + (VOICE_MAX_SAMPLES - 1) * 2, true), 32767);
    }
  }
});

test("PCM16 WAV encoding writes a valid mono RIFF header and little-endian samples", () => {
  const samples = Int16Array.from([-32768, 0, 16384, 32767]);
  const buffer = encodePcm16SamplesWav(samples, 16_000);
  const view = new DataView(buffer);
  assert.equal(buffer.byteLength, 44 + samples.length * 2);
  assert.equal(ascii(view, 0, 4), "RIFF");
  assert.equal(view.getUint32(4, true), buffer.byteLength - 8);
  assert.equal(ascii(view, 8, 4), "WAVE");
  assert.equal(ascii(view, 12, 4), "fmt ");
  assert.equal(view.getUint16(20, true), 1);
  assert.equal(view.getUint16(22, true), 1);
  assert.equal(view.getUint32(24, true), 16_000);
  assert.equal(view.getUint32(28, true), 32_000);
  assert.equal(view.getUint16(32, true), 2);
  assert.equal(view.getUint16(34, true), 16);
  assert.equal(ascii(view, 36, 4), "data");
  assert.equal(view.getUint32(40, true), samples.length * 2);
  assert.deepEqual([...new Int16Array(buffer, 44)], [...samples]);
});

test("downsampling keeps a bounded mono signal and handles 44.1/48 kHz input", () => {
  for (const rate of [44_100, 48_000]) {
    const input = new Float32Array(rate / 10).fill(0.5);
    const output = downsamplePcm(input, rate, VOICE_SAMPLE_RATE);
    assert.ok(Math.abs(output.length - 1_600) <= 1, `${rate}: ${output.length}`);
    assert.ok(output.every((sample) => Math.abs(sample - 0.5) < 1e-6));
  }
  const native = new Float32Array(100).fill(0.25);
  assert.equal(downsamplePcm(native, VOICE_SAMPLE_RATE), native);
});

test("voice transcripts append to the latest draft and preserve typing and line endings", () => {
  assert.equal(appendVoiceTranscript("Review the runner", "and add a test"), "Review the runner\nand add a test");
  assert.equal(appendVoiceTranscript("New user edit", " spoken words "), "New user edit\nspoken words");
  assert.equal(appendVoiceTranscript("Existing text\n", "spoken words"), "Existing text\nspoken words");
  assert.equal(appendVoiceTranscript("", " first words "), "first words");
  assert.equal(appendVoiceTranscript("Typed words", " "), "Typed words");
});

test("voice button actions distinguish starting, stopping and cancellation", () => {
  assert.equal(voiceButtonLabel("idle"), "Start voice input");
  assert.equal(voiceButtonLabel("requesting"), "Cancel voice input");
  assert.equal(voiceButtonLabel("recording"), "Stop voice input");
  assert.equal(voiceButtonLabel("transcribing"), "Cancel voice input");
  assert.equal(canStartVoiceInput({ ready: true, running: false, submitting: false, phase: "idle" }), true);
  assert.equal(canStartVoiceInput({ ready: true, running: true, submitting: false, phase: "idle" }), false);
  assert.equal(canStartVoiceInput({ ready: true, running: false, submitting: false, phase: "transcribing" }), false);
});

test("microphone failures map to actionable permission and device messages", () => {
  assert.match(microphoneErrorMessage({ name: "NotAllowedError" }), /System Settings/);
  assert.match(microphoneErrorMessage({ name: "NotFoundError" }), /No microphone/);
  assert.match(microphoneErrorMessage({ name: "NotReadableError" }), /busy/);
  assert.match(microphoneErrorMessage(new Error("other")), /Check the device/);
});
