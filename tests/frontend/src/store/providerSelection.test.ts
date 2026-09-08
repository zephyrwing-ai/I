import assert from "node:assert/strict";
import test from "node:test";
import type { ModelOption } from "../../../../shell/shared/ipc.js";
import { restoreSelectedModelOption, retainSelectedModelOption } from "../../../../frontend/src/store/providerSelection.js";

function model(patch: Partial<ModelOption> = {}): ModelOption {
  return {
    modelOptionId: "model-option-a",
    providerProfileId: "provider-a",
    providerName: "Provider A",
    modelId: "model-a",
    displayName: "Model A",
    available: true,
    imported: true,
    state: "saved",
    ...patch,
  };
}

test("provider refresh retains the current imported model even when it becomes unavailable", () => {
  assert.equal(
    retainSelectedModelOption("model-option-a", [model({ available: false, state: "unavailable" })]),
    "model-option-a",
  );
});

test("provider deletion clears a selection that no longer exists", () => {
  assert.equal(retainSelectedModelOption("model-option-a", []), "");
  assert.equal(restoreSelectedModelOption("model-option-a", []), "");
});

test("newly discovered models are neither retained nor restored before import", () => {
  const discovered = model({ modelOptionId: "model-option-new", imported: false, state: "new" });
  assert.equal(retainSelectedModelOption("model-option-new", [discovered]), "");
  assert.equal(restoreSelectedModelOption("model-option-new", [discovered]), "");
});

test("stored selection restores only an imported and available model", () => {
  assert.equal(restoreSelectedModelOption("model-option-a", [model()]), "model-option-a");
  assert.equal(restoreSelectedModelOption("model-option-a", [model({ available: false })]), "");
});

test("empty selections stay empty even when usable models exist", () => {
  assert.equal(retainSelectedModelOption("", [model()]), "");
  assert.equal(restoreSelectedModelOption("", [model()]), "");
});
