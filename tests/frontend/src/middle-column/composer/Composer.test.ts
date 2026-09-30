import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ModelOption } from "../../../../../shell/shared/ipc.js";

register("../../../css-module-loader.mjs", import.meta.url);

const { Composer, parseStoredModelPickerPreference, restoreStoredModelOptionId, selectComposerAction } = await import("../../../../../frontend/src/middle-column/composer/Composer.js");

const selectedModel: ModelOption = {
  modelOptionId: "model-option-a",
  providerProfileId: "provider-a",
  providerName: "Provider A",
  modelId: "model-a",
  displayName: "Model A",
  available: true,
  imported: true,
  state: "saved",
};

function renderComposer(running: boolean, stopping: boolean, activeRunId: string | null = running ? "active-run" : null): string {
  const originalError = console.error;
  console.error = (message?: unknown, ...rest: unknown[]): void => {
    if (typeof message === "string" && message.includes("useLayoutEffect does nothing on the server")) return;
    originalError(message, ...rest);
  };
  try {
    return renderToStaticMarkup(createElement(Composer, {
      running,
      stopping,
      activeRunId,
      modelOptions: [selectedModel],
      modelLoading: false,
      onRun: async () => true,
      onSteer: async () => true,
      onStop: () => undefined,
    }));
  } finally {
    console.error = originalError;
  }
}

test("idle Composer exposes task input and a disabled send action until text exists", () => {
  const html = renderComposer(false, false);
  assert.match(html, /<textarea[^>]*aria-label="Task"/);
  assert.match(html, /<button[^>]*disabled=""[^>]*aria-label="Send"/);
  assert.ok(html.includes("Choose model"), html);
  assert.doesNotMatch(html, /aria-label="Stop run"/);
});

test("Composer restores only models returned by the latest discovery", () => {
  assert.equal(
    restoreStoredModelOptionId("model-option-a", [{ ...selectedModel, available: false, state: "unavailable" }]),
    "",
  );
  assert.equal(
    restoreStoredModelOptionId("model-option-a", [{ ...selectedModel, imported: false, state: "new" }]),
    "model-option-a",
  );
});

test("Composer accepts a valid cached picker layout and falls back to the legacy model id", () => {
  assert.deepEqual(
    parseStoredModelPickerPreference(JSON.stringify({ modelOptionId: "model-option-a", displayName: "Model A", width: 143 }), null),
    { modelOptionId: "model-option-a", displayName: "Model A", width: 143 },
  );
  assert.deepEqual(
    parseStoredModelPickerPreference("{broken", "model-option-a"),
    { modelOptionId: "model-option-a", displayName: "", width: null },
  );
  assert.deepEqual(
    parseStoredModelPickerPreference(JSON.stringify({ modelOptionId: "model-option-a", displayName: "Model A", width: 0 }), "model-option-b"),
    { modelOptionId: "model-option-b", displayName: "", width: null },
  );
  assert.deepEqual(
    parseStoredModelPickerPreference(JSON.stringify({ modelOptionId: "model-option-a", displayName: "Model A", width: 143 }), "model-option-b"),
    { modelOptionId: "model-option-b", displayName: "", width: null },
  );
});

test("running Composer keeps the text input editable and shows Stop in the single action button", () => {
  const html = renderComposer(true, false);
  assert.match(html, /<textarea[^>]*aria-label="Task"/);
  assert.doesNotMatch(html, /<textarea[^>]*disabled=""/);
  assert.match(html, /<button[^>]*aria-label="Stop run"/);
  assert.doesNotMatch(html, /aria-label="Send"/);
  assert.equal(html.match(/class="send-stop-button /g)?.length, 1);
  assert.doesNotMatch(html, /aria-label="Stopping"/);
});

test("the stable action button switches from Stop to steering Send when the draft has text", () => {
  const base = { running: true, stopping: false, submitting: false, activeRunId: "active-run" };
  assert.equal(selectComposerAction({ ...base, hasText: false }), "stop");
  assert.equal(selectComposerAction({ ...base, hasText: true }), "steer");
  assert.equal(selectComposerAction({ ...base, submitting: true, hasText: true }), "submitting");
  assert.equal(selectComposerAction({ ...base, stopping: true, hasText: true }), "stopping");
  assert.equal(selectComposerAction({ ...base, running: false, activeRunId: null, hasText: true }), "start");
  assert.equal(selectComposerAction({ ...base, activeRunId: null, hasText: true }), "starting");
});

test("stopping Composer disables the stop action and reports busy state", () => {
  const html = renderComposer(true, true);
  assert.match(html, /<button[^>]*disabled=""[^>]*aria-label="Stopping"[^>]*aria-busy="true"/);
});

test("starting Composer keeps its draft editable while run identity is being established", () => {
  const html = renderComposer(true, false, null);
  assert.match(html, /<textarea[^>]*aria-label="Task"/);
  assert.doesNotMatch(html, /<textarea[^>]*disabled=""/);
  assert.doesNotMatch(html, /aria-label="Stop run"/);
  assert.match(html, /<button[^>]*disabled=""[^>]*aria-label="Send"/);
});
