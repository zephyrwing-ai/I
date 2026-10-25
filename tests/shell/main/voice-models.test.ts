import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VOICE_MODEL_MANIFEST, VoiceModelService } from "../../../shell/main/voice-models.js";

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
