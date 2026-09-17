import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ModelOption } from "../../../../../shell/shared/ipc.js";

register("../../../css-module-loader.mjs", import.meta.url);

const { Composer, parseStoredModelPickerPreference, restoreStoredModelOptionId } = await import("../../../../../frontend/src/middle-column/composer/Composer.js");

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

function renderComposer(running: boolean, stopping: boolean): string {
  const originalError = console.error;
  console.error = (message?: unknown, ...rest: unknown[]): void => {
    if (typeof message === "string" && message.includes("useLayoutEffect does nothing on the server")) return;
    originalError(message, ...rest);
  };
  try {
    return renderToStaticMarkup(createElement(Composer, {
      running,
      stopping,
      modelOptions: [selectedModel],
      modelLoading: false,
      onRun: () => undefined,
      onStop: () => undefined,
    }));
  } finally {
    console.error = originalError;
  }
}

test("idle Composer exposes task input and a disabled send action until text exists", () => {
  const html = renderComposer(false, false);
  assert.match(html, /<textarea[^>]*aria-label="任务"/);
  assert.match(html, /<button[^>]*disabled=""[^>]*aria-label="发送"/);
  assert.ok(html.includes("选择模型"), html);
  assert.doesNotMatch(html, /aria-label="停止运行"/);
});

test("Composer restores an imported saved model even when it is temporarily unavailable", () => {
  assert.equal(
    restoreStoredModelOptionId("model-option-a", [{ ...selectedModel, available: false, state: "unavailable" }]),
    "model-option-a",
  );
  assert.equal(
    restoreStoredModelOptionId("model-option-a", [{ ...selectedModel, imported: false, state: "new" }]),
    "",
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

test("running Composer locks inputs and exposes the stop action", () => {
  const html = renderComposer(true, false);
  assert.match(html, /<textarea[^>]*disabled=""[^>]*aria-label="任务"/);
  assert.match(html, /<button[^>]*aria-label="停止运行"/);
  assert.doesNotMatch(html, /aria-label="正在停止"/);
});

test("stopping Composer disables the stop action and reports busy state", () => {
  const html = renderComposer(true, true);
  assert.match(html, /<button[^>]*disabled=""[^>]*aria-label="正在停止"[^>]*aria-busy="true"/);
});
