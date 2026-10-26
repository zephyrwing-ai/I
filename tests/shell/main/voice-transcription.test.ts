import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const {
  VoiceTranscriptionService,
  extractTranscript,
  voiceResourcePaths,
} = await import("../../../shell/main/voice-transcription.js");
const { VOICE_TRANSCRIPTION_MAX_AUDIO_BYTES } = await import("../../../shell/shared/ipc.js");

function recordingWav(samples = 160, firstSample = 1): ArrayBuffer {
  const bytes = Buffer.alloc(44 + samples * 2);
  bytes.write("RIFF", 0);
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(16_000, 24);
  bytes.writeUInt32LE(32_000, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36);
  bytes.writeUInt32LE(samples * 2, 40);
  if (samples > 0) bytes.writeInt16LE(firstSample, 44);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

const wav = recordingWav();
const directories: string[] = [];
test.after(async () => Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true }))));

test("transcription requires an explicitly selected model", async () => {
  const service = new VoiceTranscriptionService({
    modelPath: () => null,
  });
  const result = await service.transcribe({ requestId: "no-selected-model", audio: recordingWav() }, 1);
  assert.equal(result.ok, false);
  assert.equal(result.error, "model_missing");
  assert.match(result.message, /Settings → Voice/);
  await service.dispose();
});

function fakeEngine(source: string): Promise<{ directory: string; executable: string; model: string }> {
  return mkdtemp(join(tmpdir(), "voice-engine-test-")).then(async (directory) => {
    directories.push(directory);
    const executable = join(directory, "whisper-cli");
    const model = join(directory, "model.bin");
    await writeFile(executable, source);
    await chmod(executable, 0o755);
    const header = Buffer.alloc(48);
    header.writeUInt32LE(0x67676d6c);
    await writeFile(model, header);
    return { directory, executable, model };
  });
}

function engineScript(output: string): string {
  return `#!/bin/sh
out=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "-of" ]; then shift; out="$1"; fi
  shift
done
${output}
`;
}

test("extractTranscript joins whisper segments and normalizes whitespace", () => {
  assert.equal(extractTranscript({
    transcription: [
      { text: " hello" },
      { text: "world " },
      { text: "\nagain" },
    ],
  }), "hello world again");
  assert.equal(extractTranscript({ transcription: [] }), "");
  assert.equal(extractTranscript({ result: "not transcription" }), "");
});

test("voice resources resolve from the app root in development and resources in a bundle", () => {
  assert.deepEqual(voiceResourcePaths({
    isPackaged: false,
    resourcesPath: "/bundle/Contents/Resources",
    appPath: "/repo",
  }), {
    enginePath: "/repo/resources/whisper/whisper-cli",
    modelPath: "/repo/resources/whisper/ggml-large-v3-turbo-q5_0.bin",
  });
  assert.deepEqual(voiceResourcePaths({
    isPackaged: true,
    resourcesPath: "/bundle/Contents/Resources",
    appPath: "/ignored",
  }), {
    enginePath: "/bundle/Contents/Resources/resources/whisper/whisper-cli",
    modelPath: "/bundle/Contents/Resources/resources/whisper/ggml-large-v3-turbo-q5_0.bin",
  });
});

test("renamed development and preview shells resolve voice resources from the loaded application", () => {
  assert.deepEqual(voiceResourcePaths({
    isPackaged: true,
    defaultApp: true,
    resourcesPath: "/repo/node_modules/.cache/macos-app/development/I.app/Contents/Resources",
    appPath: "/repo",
  }), {
    enginePath: "/repo/resources/whisper/whisper-cli",
    modelPath: "/repo/resources/whisper/ggml-large-v3-turbo-q5_0.bin",
  });
});

test("VoiceTranscriptionService rejects invalid and oversized audio before spawning", async () => {
  const service = new VoiceTranscriptionService({ enginePath: "/missing", modelPath: "/missing" });
  assert.deepEqual(await service.transcribe({ requestId: "empty", audio: new ArrayBuffer(0) }, 1), {
    ok: false,
    error: "invalid_audio",
    message: "The recording is empty. Record again and retry.",
  });
  assert.equal((await service.transcribe({ requestId: "bad", audio: "not audio" } as never, 1)).ok, false);
  const oversized = await service.transcribe({
    requestId: "oversized", audio: new ArrayBuffer(VOICE_TRANSCRIPTION_MAX_AUDIO_BYTES + 2),
  }, 1);
  assert.equal(oversized.ok, false);
  if (!oversized.ok) assert.equal(oversized.error, "invalid_audio");
});

test("VoiceTranscriptionService reports missing resources without touching a temporary directory", async () => {
  const directory = await mkdtemp(join(tmpdir(), "voice-service-test-"));
  directories.push(directory);
  const service = new VoiceTranscriptionService({
    enginePath: join(directory, "missing-cli"),
    modelPath: join(directory, "missing-model"),
    temporaryDirectory: join(directory, "tmp"),
  });
  const result = await service.transcribe({ requestId: "missing", audio: wav }, 1);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error, "engine_missing");
});

test("VoiceTranscriptionService invokes the engine once, parses JSON and removes temp files", async () => {
  const engine = await fakeEngine(engineScript(`
cat > "$out.json" <<'JSON'
{"transcription":[{"text":" Build a focused test."},{"text":"Keep the draft."}]}
JSON
`));
  const temporaryDirectory = join(engine.directory, "tmp");
  const service = new VoiceTranscriptionService({
    enginePath: engine.executable,
    modelPath: engine.model,
    temporaryDirectory,
  });
  const result = await service.transcribe({ requestId: "ok", audio: wav }, 1);
  assert.deepEqual(result, { ok: true, text: "Build a focused test. Keep the draft." });
  assert.deepEqual(await readdir(temporaryDirectory), []);
});

test("VoiceTranscriptionService maps engine failure and empty transcription", async () => {
  const failing = await fakeEngine(engineScript(`echo "engine exploded" >&2; exit 7`));
  const failingService = new VoiceTranscriptionService({
    enginePath: failing.executable,
    modelPath: failing.model,
    temporaryDirectory: join(failing.directory, "tmp"),
  });
  const failure = await failingService.transcribe({ requestId: "fail", audio: wav }, 1);
  assert.equal(failure.ok, false);
  if (!failure.ok) {
    assert.equal(failure.error, "transcription_failed");
    assert.match(failure.message, /engine exploded/);
  }

  const empty = await fakeEngine(engineScript(`echo '{"transcription":[]}' > "$out.json"`));
  const emptyService = new VoiceTranscriptionService({
    enginePath: empty.executable,
    modelPath: empty.model,
    temporaryDirectory: join(empty.directory, "tmp"),
  });
  const noSpeech = await emptyService.transcribe({ requestId: "empty-result", audio: wav }, 1);
  assert.equal(noSpeech.ok, false);
  if (!noSpeech.ok) assert.equal(noSpeech.error, "no_speech");
});

test("VoiceTranscriptionService cancel aborts the active engine and keeps ownership", async () => {
  const engine = await fakeEngine(engineScript(`exec sleep 10`));
  const service = new VoiceTranscriptionService({
    enginePath: engine.executable,
    modelPath: engine.model,
    temporaryDirectory: join(engine.directory, "tmp"),
  });
  const pending = service.transcribe({ requestId: "cancel", audio: wav }, 7);
  await new Promise((resolve) => setTimeout(resolve, 80));
  service.cancel("cancel", 8);
  assert.equal(service.cancel("cancel", 7), undefined);
  const result = await pending;
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error, "cancelled");
});

test("VoiceTranscriptionService serializes duplicate request identities", async () => {
  const engine = await fakeEngine(engineScript(`sleep 1; echo '{"transcription":[{"text":"done"}]}' > "$out.json"`));
  const service = new VoiceTranscriptionService({
    enginePath: engine.executable,
    modelPath: engine.model,
    temporaryDirectory: join(engine.directory, "tmp"),
  });
  const first = service.transcribe({ requestId: "same", audio: wav }, 1);
  await new Promise((resolve) => setTimeout(resolve, 50));
  const duplicate = await service.transcribe({ requestId: "same", audio: wav }, 1);
  assert.equal(duplicate.ok, false);
  if (!duplicate.ok) assert.equal(duplicate.error, "invalid_request");
  const result = await first;
  assert.equal(result.ok, true);
});

test("VoiceTranscriptionService writes audio into a temporary file", async () => {
  const engine = await fakeEngine(engineScript(`
for arg in "$@"; do
  if [ "$arg" = "-f" ]; then audio=1; continue; fi
  if [ "\${audio:-}" = "1" ]; then
    [ "$(wc -c < "$arg")" -eq ${wav.byteLength} ] || exit 9
    audio=0
  fi
done
echo '{"transcription":[{"text":"ok"}]}' > "$out.json"
`));
  const service = new VoiceTranscriptionService({
    enginePath: engine.executable,
    modelPath: engine.model,
    temporaryDirectory: join(engine.directory, "tmp"),
  });
  const result = await service.transcribe({ requestId: "bytes", audio: wav }, 1);
  assert.deepEqual(result, { ok: true, text: "ok" });
});


test("VoiceTranscriptionService validates WAV metadata before spawning", async () => {
  const service = new VoiceTranscriptionService({ enginePath: "/missing", modelPath: "/missing" });
  const malformed = wav.slice(0);
  new DataView(malformed).setUint32(24, 48_000, true);
  for (const audio of [new Uint8Array(50).buffer, malformed]) {
    const result = await service.transcribe({ requestId: "invalid-wav", audio }, 1);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error, "invalid_audio");
  }
});

test("VoiceTranscriptionService accepts recordings beyond ten minutes within the audio byte budget", async () => {
  const engine = await fakeEngine(engineScript(`echo '{"transcription":[{"text":"long recording"}]}' > "$out.json"`));
  const service = new VoiceTranscriptionService({ enginePath: engine.executable, modelPath: engine.model });
  assert.deepEqual(await service.transcribe({ requestId: "long", audio: recordingWav(16_000 * 610) }, 1), {
    ok: true, text: "long recording",
  });
});

test("VoiceTranscriptionService rejects invalid model headers and nonexecutable engine resources", async () => {
  const engine = await fakeEngine(engineScript("exit 1"));
  const service = new VoiceTranscriptionService({ enginePath: engine.executable, modelPath: engine.model });
  await writeFile(engine.model, "truncated model");
  const modelResult = await service.transcribe({ requestId: "invalid-model", audio: wav }, 1);
  assert.equal(modelResult.ok, false);
  if (!modelResult.ok) assert.equal(modelResult.error, "model_missing");
  await chmod(engine.executable, 0o644);
  const engineResult = await service.transcribe({ requestId: "invalid-engine", audio: wav }, 1);
  assert.equal(engineResult.ok, false);
  if (!engineResult.ok) assert.equal(engineResult.error, "engine_missing");
});

test("VoiceTranscriptionService bounds native concurrency across owners and prevents foreign cancellation", async () => {
  const engine = await fakeEngine(engineScript(`sleep 0.2; echo '{"transcription":[{"text":"owner kept"}]}' > "$out.json"`));
  const service = new VoiceTranscriptionService({ enginePath: engine.executable, modelPath: engine.model });
  const first = service.transcribe({ requestId: "shared-id", audio: wav }, 7);
  const otherOwner = await service.transcribe({ requestId: "shared-id", audio: wav }, 8);
  assert.equal(otherOwner.ok, false);
  if (!otherOwner.ok) assert.equal(otherOwner.error, "invalid_request");
  service.cancel("shared-id", 8);
  service.cancelOwner(8);
  assert.deepEqual(await first, { ok: true, text: "owner kept" });
});

test("VoiceTranscriptionService disposal waits for native termination and temporary-file cleanup", async () => {
  const engine = await fakeEngine(`#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
process.on("SIGTERM", () => {});
fs.writeFileSync(path.join(__dirname, "ready"), String(process.pid));
setInterval(() => {}, 1000);
`);
  const temporaryDirectory = join(engine.directory, "tmp");
  const service = new VoiceTranscriptionService({ enginePath: engine.executable, modelPath: engine.model, temporaryDirectory });
  const pending = service.transcribe({ requestId: "dispose", audio: wav }, 7);
  let pid = 0;
  const deadline = Date.now() + 2_000;
  while (!pid && Date.now() < deadline) {
    try { pid = Number(await readFile(join(engine.directory, "ready"), "utf8")); } catch {}
    if (!pid) await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(pid, "native engine started");
  let disposed = false;
  const disposal = service.dispose().then(() => { disposed = true; });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(disposed, false);
  assert.equal((await readdir(temporaryDirectory)).length, 1, "audio retained until native exit");
  await disposal;
  const result = await pending;
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error, "cancelled");
  assert.deepEqual(await readdir(temporaryDirectory), []);
  assert.throws(() => process.kill(pid, 0), /ESRCH/);
  const afterDispose = await service.transcribe({ requestId: "late", audio: wav }, 7);
  assert.equal(afterDispose.ok, false);
  if (!afterDispose.ok) assert.equal(afterDispose.error, "cancelled");
});


test("VoiceTranscriptionService rejects digital silence before inference and preserves quiet nonzero audio", async () => {
  const directory = await mkdtemp(join(tmpdir(), "voice-silence-test-"));
  directories.push(directory);
  const temporaryDirectory = join(directory, "tmp");
  const missingEngine = new VoiceTranscriptionService({
    enginePath: join(directory, "missing-engine"),
    modelPath: join(directory, "missing-model"),
    temporaryDirectory,
  });
  const silent = await missingEngine.transcribe({ requestId: "digital-silence", audio: recordingWav(16_000 * 3, 0) }, 1);
  assert.deepEqual(silent, {
    ok: false,
    error: "no_speech",
    message: "No speech was detected. Record again and retry.",
  });
  await assert.rejects(readdir(temporaryDirectory), { code: "ENOENT" });

  const engine = await fakeEngine(engineScript(`echo '{"transcription":[{"text":"quiet speech"}]}' > "$out.json"`));
  const service = new VoiceTranscriptionService({ enginePath: engine.executable, modelPath: engine.model });
  const quiet = await service.transcribe({ requestId: "quiet", audio: recordingWav(16_000 * 3, -1) }, 1);
  assert.deepEqual(quiet, { ok: true, text: "quiet speech" });
});
