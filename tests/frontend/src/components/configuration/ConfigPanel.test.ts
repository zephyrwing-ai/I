import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ModelOption, ProviderProfileSummary } from "../../../../../shell/shared/ipc.js";

register("../../../css-module-loader.mjs", import.meta.url);

const { ConfigPanel } = await import("../../../../../frontend/src/components/ConfigPanel.js");

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

function profile(): ProviderProfileSummary {
  return {
    providerProfileId: "provider-a",
    name: "Provider A",
    baseURL: "https://api.example.test/v1",
    credentialConfigured: true,
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

function renderPanel(options: {
  profiles?: ProviderProfileSummary[];
  loading?: boolean;
  error?: string | null;
  disabled?: boolean;
} = {}): string {
  return renderToStaticMarkup(createElement(ConfigPanel, {
    profiles: options.profiles ?? [],
    loading: options.loading ?? false,
    error: options.error ?? null,
    disabled: options.disabled ?? false,
    onClose: () => undefined,
    onRefresh: async () => undefined,
  }));
}

function button(html: string, ariaLabel: string): string {
  const match = html.match(new RegExp(`<button[^>]*aria-label="${ariaLabel}"[^>]*>`));
  assert.ok(match, `missing button: ${ariaLabel}\n${html}`);
  return match[0];
}

test("ConfigPanel distinguishes loading, empty, and catalog error states", () => {
  const loading = renderPanel({ loading: true });
  assert.ok(loading.includes("正在读取提供商。"), loading);
  assert.ok(!loading.includes("尚未添加提供商。"), loading);

  const empty = renderPanel();
  assert.ok(empty.includes("尚未添加提供商。添加并保存后，模型才会进入 Composer。"), empty);

  const failed = renderPanel({ error: "无法读取提供商" });
  assert.match(failed, /<p class="form-error" role="alert">/);
  assert.ok(failed.includes("无法读取提供商"), failed);
});

test("ConfigPanel summarizes imported and newly discovered models without expanding the card", () => {
  const html = renderPanel({ profiles: [profile()] });

  assert.ok(html.includes("https://api.example.test/v1 · 2 个模型 · 1 个新增"), html);
  assert.match(html, /aria-expanded="false"/);
  assert.match(html, /class="provider-model-collapse" aria-hidden="true"/);
  assert.ok(html.includes("model-new"), html);
  assert.ok(html.includes("新增"), html);
  assert.ok(html.includes("不可用"), html);
});

test("a running task locks provider mutations while leaving navigation and disclosure available", () => {
  const html = renderPanel({ profiles: [profile()], disabled: true });

  assert.ok(button(html, "重新拉取 Provider A 的模型").includes('disabled=""'));
  assert.ok(button(html, "编辑 Provider A").includes('disabled=""'));
  assert.ok(button(html, "删除 Provider A").includes('disabled=""'));
  assert.match(html, /<button[^>]*class="primary-button add-provider-button"[^>]*disabled=""/);

  assert.ok(!button(html, "关闭设置").includes("disabled"));
  const disclosure = html.match(/<button[^>]*class="provider-card-toggle"[^>]*>/)?.[0];
  assert.ok(disclosure, html);
  assert.ok(!disclosure.includes("disabled"), disclosure);
});
