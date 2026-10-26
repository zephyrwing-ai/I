import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VOICE_MODEL_MANIFEST, VoiceModelService } from "../../../shell/main/voice-models.js";
import { readGgmlModelInfo } from "../../../shell/main/ggml-model.js";

function recordingEvents() {
  const events: Array<{ modelId: string; status: string; progress: number | null }> = [];
  return {
    events,
    send: (event: { modelId: string; status: string; progress: number | null }) => events.push(event),
  };
}

function bytesBody(bytes: Uint8Array) {
  let index = 0;
  return {
    getReader: () => ({
      read: async () => (
        index < bytes.length
          ? { done: false, value: bytes.subarray(index, index += 1) }
          : { done: true }
      ),
    }),
  };
}

async function writeGgmlFixture(
  path: string,
  audioState = 384,
  audioLayers = 4,
): Promise<void> {
  const file = Buffer.alloc(2 * 1024 * 1024);
  file.writeUInt32LE(0x67676d6c, 0);
  file.writeUInt32LE(1, 4);
  file.writeInt32LE(51865, 8);
  file.writeInt32LE(1500, 12);
  file.writeInt32LE(audioState, 16);
  file.writeInt32LE(6, 20);
  file.writeInt32LE(audioLayers, 24);
  file.writeInt32LE(448, 28);
  file.writeInt32LE(384, 32);
  file.writeInt32LE(6, 36);
  file.writeInt32LE(4, 40);
  file.writeInt32LE(80, 44);
  file.writeInt32LE(8, 48);
  await writeFile(path, file);
}

test("voice model manifest stays internally consistent", () => {
  const ids = new Set(VOICE_MODEL_MANIFEST.map((entry) => entry.id));
  assert.equal(ids.size, VOICE_MODEL_MANIFEST.length);
  assert.equal(VOICE_MODEL_MANIFEST.filter((entry) => entry.recommended).length, 1);
  for (const entry of VOICE_MODEL_MANIFEST) {
    assert.ok(entry.speedLevel >= 1 && entry.speedLevel <= 5, `${entry.id} speed level`);
    assert.match(entry.sha256, /^[0-9a-f]{64}$/);
    assert.ok(entry.fileName.endsWith(".bin"));
  }
});

test("GGML header identifies the model family and quantization", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ggml-header-"));
  t.after(() => import("node:fs/promises").then(({ rm }) => rm(directory, { recursive: true, force: true })));
  const path = join(directory, "ggml-tiny-q8_0.bin");
  await writeGgmlFixture(path);
  const info = await readGgmlModelInfo(path);
  assert.equal(info?.family, "tiny");
  assert.equal(info?.quantization, "q8_0");
  assert.equal(info?.bytes, 2 * 1024 * 1024);
});

test("automatic scan discovers local GGML models and allows selecting them", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "voice-model-scan-"));
  t.after(() => import("node:fs/promises").then(({ rm }) => rm(directory, { recursive: true, force: true })));
  const library = join(directory, "library");
  await mkdir(library);
  const customPath = join(library, "ggml-custom-q8_0.bin");
  await writeGgmlFixture(customPath, 640, 8);
  await writeFile(join(library, "notes.txt"), "not a model");

  const recorder = recordingEvents();
  const service = new VoiceModelService({
    modelsDirectory: join(directory, "managed"),
    statePath: join(directory, "state.json"),
    scanDirectories: [library],
    sendEvent: recorder.send,
  });
  await service.load();
  assert.deepEqual(await service.scan(), { ok: true });

  const found = service.list().find((model) => model.name === "custom-q8_0");
  assert.ok(found, "scanned model appears in the unified list");
  assert.equal(found?.status, "installed");
  assert.equal(found?.tag, "GGML q8_0");

  assert.deepEqual(await service.select(found.id), { ok: true });
  assert.equal(service.currentModelPath(), customPath);
});

test("bundled model is installed but must be explicitly selected", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "voice-model-bundled-"));
  t.after(() => import("node:fs/promises").then(({ rm }) => rm(directory, { recursive: true, force: true })));
  const bundled = join(directory, "ggml-large-v3-turbo-q5_0.bin");
  await writeFile(bundled, Buffer.alloc(4));
  const service = new VoiceModelService({
    modelsDirectory: join(directory, "managed"),
    statePath: join(directory, "state.json"),
    bundledModelPath: bundled,
    scanDirectories: [],
    sendEvent: recordingEvents().send,
  });
  await service.load();

  const turbo = service.list().find((model) => model.id === "whisper-large-v3-turbo");
  assert.equal(turbo?.status, "installed");
  assert.equal(turbo?.selected, false);
  assert.equal(service.currentModelPath(), null);
  assert.deepEqual(await service.select("whisper-large-v3-turbo"), { ok: true });
  assert.equal(service.currentModelPath(), bundled);
  assert.deepEqual(await service.select("whisper-large-v3-turbo"), { ok: true });
  assert.equal(service.currentModelPath(), null);
  assert.equal(service.list().find((model) => model.id === "whisper-large-v3-turbo")?.selected, false);
});

test("scanning a catalog filename marks the catalog model as installed", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "voice-model-catalog-scan-"));
  t.after(() => import("node:fs/promises").then(({ rm }) => rm(directory, { recursive: true, force: true })));
  const library = join(directory, "library");
  await mkdir(library);
  const modelPath = join(library, "ggml-tiny-q8_0.bin");
  await writeGgmlFixture(modelPath);

  const service = new VoiceModelService({
    modelsDirectory: join(directory, "managed"),
    statePath: join(directory, "state.json"),
    scanDirectories: [library],
    sendEvent: recordingEvents().send,
  });
  await service.load();
  assert.deepEqual(await service.scan(), { ok: true });

  const tiny = service.list().find((model) => model.id === "whisper-tiny");
  assert.equal(tiny?.status, "installed");
  assert.equal(service.list().filter((model) => model.name === "Whisper tiny").length, 1);
});

test("voice model state restores installed models and the selected model", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "voice-models-state-"));
  t.after(() => import("node:fs/promises").then(({ rm }) => rm(directory, { recursive: true, force: true })));
  const statePath = join(directory, "state.json");
  const recorder = recordingEvents();
  await writeFile(statePath, JSON.stringify({
    selectedId: "whisper-base",
    installed: { "whisper-base": { sha256: "a".repeat(64), bytes: 82 } },
  }), "utf8");

  const service = new VoiceModelService({
    modelsDirectory: join(directory, "models"),
    statePath,
    sendEvent: recorder.send,
  });
  await service.load();

  const listed = service.list();
  const base = listed.find((model) => model.id === "whisper-base");
  assert.equal(base?.status, "installed");
  assert.equal(base?.selected, true);

  const result = await service.select("whisper-medium");
  assert.equal(result.ok, false, "uninstalled models cannot be selected");

  const persisted = JSON.parse(await readFile(statePath, "utf8"));
  assert.equal(persisted.selectedId, "whisper-base");
});

test("voice model download rejects files that fail their checksum", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "voice-models-download-"));
  t.after(() => import("node:fs/promises").then(({ rm }) => rm(directory, { recursive: true, force: true })));
  const recorder = recordingEvents();
  const fakeFetch = async () => ({
    ok: true,
    status: 200,
    headers: { get: (name: string) => (name === "content-length" ? "3" : null) },
    body: bytesBody(new TextEncoder().encode("bad")),
  });
  const service = new VoiceModelService({
    modelsDirectory: join(directory, "models"),
    statePath: join(directory, "state.json"),
    fetchImpl: fakeFetch,
    sendEvent: recorder.send,
  });

  const result = await service.download("whisper-tiny");
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /integrity/);
  assert.equal(service.list().find((model) => model.id === "whisper-tiny")?.status, "not_downloaded");
  assert.deepEqual(await readdir(join(directory, "models")), []);
});

test("cancelling a voice model download aborts the stream and cleans the part file", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "voice-models-cancel-"));
  t.after(() => import("node:fs/promises").then(({ rm }) => rm(directory, { recursive: true, force: true })));
  const recorder = recordingEvents();
  let capturedSignal: AbortSignal | null = null;
  const fakeFetch = async (_url: string, init?: { signal?: AbortSignal }) => {
    capturedSignal = init?.signal ?? null;
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      body: {
        getReader: () => ({
          read: () => new Promise<{ done: boolean; value?: Uint8Array }>((_resolve, reject) => {
            capturedSignal?.addEventListener("abort", () => {
              reject(new Error("aborted"));
            }, { once: true });
          }),
        }),
      },
    };
  };
  const service = new VoiceModelService({
    modelsDirectory: join(directory, "models"),
    statePath: join(directory, "state.json"),
    fetchImpl: fakeFetch,
    sendEvent: recorder.send,
  });

  const pending = service.download("whisper-tiny");
  await new Promise((resolve) => setTimeout(resolve, 20));
  service.cancel("whisper-tiny");
  const result = await pending;
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /cancelled/);
  assert.equal(service.list().find((model) => model.id === "whisper-tiny")?.status, "not_downloaded");
  assert.deepEqual(await readdir(join(directory, "models")), []);
});
