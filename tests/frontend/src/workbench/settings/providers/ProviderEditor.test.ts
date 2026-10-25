import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ModelOption, ProviderProfileSummary } from "../../../../../../shell/shared/ipc.js";

register("../../../../css-module-loader.mjs", import.meta.url);

const { ProviderEditor, initialModels, providerModelsForSave } = await import("../../../../../../frontend/src/workbench/settings/providers/ProviderEditor.js");

function model(patch: Partial<ModelOption>): ModelOption {
  return {
    modelOptionId: "provider-a:model-a",
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

function profile(credentialConfigured = true): ProviderProfileSummary {
  return {
    providerProfileId: "provider-a",
    name: "Provider A",
    baseURL: "https://api.example.test/v1",
    credentialConfigured,
    models: [
      model({}),
      model({
        modelOptionId: "provider-a:model-new",
        modelId: "model-new",
        displayName: "Model New",
        imported: false,
        state: "new",
      }),
      model({
        modelOptionId: "provider-a:model-old",
        modelId: "model-old",
        displayName: "Model Old",
        available: false,
        state: "unavailable",
      }),
    ],
  };
}

function renderEditor(options: {
  profile?: ProviderProfileSummary;
  disabled?: boolean;
} = {}): string {
  return renderToStaticMarkup(createElement(ProviderEditor, {
    profile: options.profile,
    disabled: options.disabled ?? false,
    onCancel: () => undefined,
    onSaved: async () => undefined,
  }));
}

function inputBy(html: string, attribute: string): string {
  const match = html.match(new RegExp(`<input[^>]*${attribute}[^>]*>`));
  assert.ok(match, `missing input with ${attribute}\n${html}`);
  return match[0];
}

function buttonWithText(html: string, text: string): string {
  const matches = html.match(/<button[^>]*>.*?<\/button>/g) ?? [];
  const match = matches.find((candidate) => candidate.includes(text));
  assert.ok(match, `missing button containing: ${text}\n${html}`);
  return match;
}

test("a new provider starts as an isolated empty draft that cannot be fetched or saved", () => {
  const html = renderEditor();

  assert.match(html, /<section class="provider-editor" aria-label="Add provider">/);
  assert.ok(inputBy(html, 'placeholder="e.g. OpenAI"').includes('value=""'));
  assert.ok(inputBy(html, 'placeholder="https://api.example.com/v1"').includes('value=""'));
  const apiKey = inputBy(html, 'placeholder="Enter an API Key"');
  assert.ok(apiKey.includes('type="password"'));
  assert.ok(apiKey.includes('value=""'));
  assert.ok(apiKey.includes('autoComplete="off"'));
  assert.match(html, /aria-label="Show API Key"/);
  assert.ok(html.includes("No models yet. Fetch the model list first."), html);
  assert.ok(html.includes("Selected 0/0 models"), html);
  assert.ok(buttonWithText(html, "Fetch model list").includes('disabled=""'));
  assert.ok(buttonWithText(html, "Save provider").includes('disabled=""'));
});

test("editing loads saved connection and model state while keeping the credential opaque", () => {
  const html = renderEditor({ profile: profile() });

  assert.match(html, /<section class="provider-editor" aria-label="Edit provider">/);
  assert.ok(inputBy(html, 'placeholder="e.g. OpenAI"').includes('value="Provider A"'));
  assert.ok(inputBy(html, 'placeholder="https://api.example.com/v1"').includes('value="https://api.example.test/v1"'));
  const apiKey = inputBy(html, 'placeholder="Leave blank to use saved credentials"');
  assert.ok(apiKey.includes('value=""'));
  assert.ok(!html.includes("credentialConfigured"), html);
  assert.match(html, /aria-label="Show API Key"/);

  assert.ok(!html.includes("Loaded saved models."), html);
  assert.ok(html.includes("Selected 3/3 models"), html);
  assert.ok(!html.includes("新增"), html);
  assert.ok(!html.includes("不可用"), html);
  assert.ok(html.includes("model-old"), html);
  assert.ok(!buttonWithText(html, "Fetch model list").includes("disabled"));
  assert.ok(!buttonWithText(html, "Save provider").includes("disabled"));
});

test("saved credentials are required to refresh an edit without entering a replacement key", () => {
  const withCredential = renderEditor({ profile: profile(true) });
  const withoutCredential = renderEditor({ profile: profile(false) });

  assert.ok(!buttonWithText(withCredential, "Fetch model list").includes("disabled"));
  assert.ok(buttonWithText(withoutCredential, "Fetch model list").includes('disabled=""'));
  assert.ok(inputBy(withoutCredential, 'placeholder="Enter an API Key"').includes('value=""'));
  assert.ok(buttonWithText(withoutCredential, "Save provider").includes('disabled=""'));
});

test("running state locks editor mutations but still allows abandoning the draft", () => {
  const html = renderEditor({ profile: profile(), disabled: true });

  assert.ok(inputBy(html, 'placeholder="e.g. OpenAI"').includes('disabled=""'));
  assert.ok(inputBy(html, 'placeholder="https://api.example.com/v1"').includes('disabled=""'));
  assert.ok(inputBy(html, 'placeholder="Leave blank to use saved credentials"').includes('disabled=""'));
  assert.ok(inputBy(html, 'aria-label="Search models"').includes('value=""'));
  assert.ok(buttonWithText(html, "Fetch model list").includes('disabled=""'));
  assert.ok(buttonWithText(html, "Save provider").includes('disabled=""'));
  assert.ok(!buttonWithText(html, "Cancel").includes("disabled"));

  const modelCheckboxes = html.match(/<input type="checkbox"[^>]*>/g) ?? [];
  assert.equal(modelCheckboxes.length, 4);
  assert.ok(modelCheckboxes.every((input) => input.includes('disabled=""')));
});

test("model limits round-trip through editing and manual overrides keep the input limit", () => {
  const saved = profile();
  saved.models[0]!.capabilities = {
    contextWindowTokens: 128_000, maxInputTokens: 100_000, maxOutputTokens: 16_000, source: "provider",
  };
  const drafts = initialModels(saved);
  assert.deepEqual(providerModelsForSave(drafts)[0]?.capabilities, saved.models[0]!.capabilities);
  const html = renderEditor({ profile: saved });
  assert.match(html, /<details class="model-capabilities"><summary>Model limits<\/summary>/);
  assert.ok(inputBy(html, 'aria-label="Context window tokens for model-a"').includes('value="128000"'));
  assert.ok(inputBy(html, 'aria-label="Max output tokens for model-a"').includes('value="16000"'));
  const manual = providerModelsForSave([{
    ...drafts[0]!, capabilityInputs: { contextWindowTokens: "160000", maxOutputTokens: "32000" },
  }]);
  assert.deepEqual(manual[0]?.capabilities, {
    contextWindowTokens: 160_000, maxInputTokens: 100_000, maxOutputTokens: 32_000, source: "manual",
  });
  assert.deepEqual(providerModelsForSave([{
    id: "custom-model", displayName: "Custom model", selected: true, state: "saved",
    capabilityInputs: { contextWindowTokens: "64000", maxOutputTokens: "8000" },
  }])[0]?.capabilities, { contextWindowTokens: 64_000, maxOutputTokens: 8_000, source: "manual" });
  assert.equal(providerModelsForSave([{ ...drafts[0]!, selected: false }]).length, 0);
});

test("manual limits reject incomplete or malformed values before creating the save payload", () => {
  const draft = initialModels(profile())[0]!;
  for (const contextWindowTokens of ["", "0", "-1", "1.5", "1e6", "9007199254740992", "unknown"]) {
    assert.throws(() => providerModelsForSave([{
      ...draft, capabilityInputs: { contextWindowTokens, maxOutputTokens: "4000" },
    }]), /context window tokens/);
  }
  for (const maxOutputTokens of ["0", "-1", "1.5", "1e6", "9007199254740992", "unknown"]) {
    assert.throws(() => providerModelsForSave([{
      ...draft, capabilityInputs: { contextWindowTokens: "32000", maxOutputTokens },
    }]), /max output tokens/);
  }
  assert.throws(() => providerModelsForSave([{
    ...draft, capabilityInputs: { contextWindowTokens: "32000", maxOutputTokens: "64000" },
  }]), /within the context window/);
});

test("changing provider origin discards inherited limits while a fresh fetch or explicit edit binds new limits", () => {
  const saved = profile();
  saved.models[0]!.capabilities = { contextWindowTokens: 128_000, maxInputTokens: 100_000, source: "provider" };
  const draft = initialModels(saved)[0]!;
  const newOrigin = "https://other.example.test/v1";
  assert.equal(providerModelsForSave([draft], newOrigin)[0]?.capabilities, undefined);
  assert.equal(providerModelsForSave([{
    ...draft, capabilityInputs: { contextWindowTokens: "64000", maxOutputTokens: "8000", origin: saved.baseURL },
  }], newOrigin)[0]?.capabilities, undefined);
  assert.equal(providerModelsForSave([draft], "https://api.example.test/v2")[0]?.capabilities?.contextWindowTokens, 128_000);
  assert.equal(providerModelsForSave([{ ...draft, capabilityOrigin: newOrigin }], newOrigin)[0]?.capabilities?.contextWindowTokens, 128_000);
  const manual = providerModelsForSave([{
    ...draft, capabilityInputs: { contextWindowTokens: "64000", maxOutputTokens: "8000" },
  }], newOrigin)[0]!.capabilities!;
  assert.equal(manual.contextWindowTokens, 64_000);
  assert.equal(manual.maxInputTokens, undefined);
  assert.equal(manual.source, "manual");
  const narrowed = providerModelsForSave([{
    ...draft, capabilityInputs: { contextWindowTokens: "64000", maxOutputTokens: "8000" },
  }], saved.baseURL)[0]!.capabilities!;
  assert.equal(narrowed.maxInputTokens, 100_000);
});
