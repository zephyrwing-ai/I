import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ModelOption, ProviderProfileSummary } from "../../../../../shell/shared/ipc.js";

register("../../../css-module-loader.mjs", import.meta.url);

const { ProviderEditor } = await import("../../../../../frontend/src/components/ProviderEditor.js");

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

  assert.match(html, /<section class="provider-editor" aria-label="添加提供商">/);
  assert.ok(inputBy(html, 'placeholder="例如 OpenAI"').includes('value=""'));
  assert.ok(inputBy(html, 'placeholder="https://api.example.com/v1"').includes('value=""'));
  const apiKey = inputBy(html, 'placeholder="输入 API Key"');
  assert.ok(apiKey.includes('type="password"'));
  assert.ok(apiKey.includes('value=""'));
  assert.ok(apiKey.includes('autoComplete="off"'));
  assert.ok(html.includes("尚无模型，请先获取模型列表。"), html);
  assert.ok(html.includes("选择 0/0 模型"), html);
  assert.ok(buttonWithText(html, "获取模型列表").includes('disabled=""'));
  assert.ok(buttonWithText(html, "保存提供商").includes('disabled=""'));
});

test("editing loads saved connection and model state while keeping the credential opaque", () => {
  const html = renderEditor({ profile: profile() });

  assert.match(html, /<section class="provider-editor" aria-label="编辑提供商">/);
  assert.ok(inputBy(html, 'placeholder="例如 OpenAI"').includes('value="Provider A"'));
  assert.ok(inputBy(html, 'placeholder="https://api.example.com/v1"').includes('value="https://api.example.test/v1"'));
  const apiKey = inputBy(html, 'placeholder="留空使用已保存凭据"');
  assert.ok(apiKey.includes('value=""'));
  assert.ok(!html.includes("credentialConfigured"), html);

  assert.ok(html.includes("已加载保存的模型。"), html);
  assert.ok(html.includes("选择 2/3 模型"), html);
  assert.ok(html.includes('class="model-state is-new">新增'), html);
  assert.ok(html.includes('class="discovered-model-row is-unavailable"'), html);
  assert.ok(html.includes('class="model-state is-unavailable">不可用'), html);
  assert.ok(!buttonWithText(html, "获取模型列表").includes("disabled"));
  assert.ok(!buttonWithText(html, "保存提供商").includes("disabled"));
});

test("saved credentials are required to refresh an edit without entering a replacement key", () => {
  const withCredential = renderEditor({ profile: profile(true) });
  const withoutCredential = renderEditor({ profile: profile(false) });

  assert.ok(!buttonWithText(withCredential, "获取模型列表").includes("disabled"));
  assert.ok(buttonWithText(withoutCredential, "获取模型列表").includes('disabled=""'));
});

test("running state locks editor mutations but still allows abandoning the draft", () => {
  const html = renderEditor({ profile: profile(), disabled: true });

  assert.ok(inputBy(html, 'placeholder="例如 OpenAI"').includes('disabled=""'));
  assert.ok(inputBy(html, 'placeholder="https://api.example.com/v1"').includes('disabled=""'));
  assert.ok(inputBy(html, 'placeholder="留空使用已保存凭据"').includes('disabled=""'));
  assert.ok(inputBy(html, 'aria-label="搜索模型"').includes('value=""'));
  assert.ok(buttonWithText(html, "获取模型列表").includes('disabled=""'));
  assert.ok(buttonWithText(html, "保存提供商").includes('disabled=""'));
  assert.ok(!buttonWithText(html, "取消").includes("disabled"));

  const modelCheckboxes = html.match(/<input type="checkbox"[^>]*>/g) ?? [];
  assert.equal(modelCheckboxes.length, 4);
  assert.ok(modelCheckboxes.every((input) => input.includes('disabled=""')));
});
