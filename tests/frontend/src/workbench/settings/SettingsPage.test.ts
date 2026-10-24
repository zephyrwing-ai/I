import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { register } from "node:module";

register("../../../css-module-loader.mjs", import.meta.url);

const { SettingsPage } = await import("../../../../../frontend/src/workbench/settings/SettingsPage.js");

function renderSettings(section: "general" | "providers" | "usage" | "tts" = "general"): string {
  return renderToStaticMarkup(createElement(SettingsPage, {
    section,
    profiles: [],
    loading: false,
    error: null,
    disabled: false,
    onSectionChange: () => undefined,
    onBack: () => undefined,
    onRefresh: async () => undefined,
  }));
}

test("SettingsPage exposes Back and separate General, Providers, Usage, and TTS sections", () => {
  const html = renderSettings();

  assert.match(html, /aria-label="Settings"/);
  assert.match(html, /<span>Back<\/span>/);
  assert.match(html, /<span>General<\/span>/);
  assert.match(html, /<span>Providers<\/span>/);
  assert.match(html, /<span>Usage<\/span>/);
  assert.match(html, /<span>TTS<\/span>/);
  assert.match(html, /aria-current="page"[^>]*>.*General/s);
  assert.match(html, /<h1 id="settings-general-title">General<\/h1>/);
  assert.doesNotMatch(html, /class="provider-list"/);
});

test("General settings render closed shared comboboxes with local labels and visible values", () => {
  const html = renderSettings();

  for (const [id, label, value] of [
    ["settings-appearance", "Appearance", "System"],
    ["settings-language", "Language", "English"],
  ]) {
    assert.match(html, new RegExp(`<dt><span id="${id}-label">${label}</span></dt>`));
    assert.doesNotMatch(html, new RegExp(`<label\\b[^>]*for="${id}"`));
    const button = html.match(new RegExp(`<button\\b[^>]*id="${id}"[^>]*>[\\s\\S]*?</button>`))?.[0];
    assert.ok(button, `${label} has a button trigger`);
    const trigger = button.slice(0, button.indexOf(">") + 1);
    assert.match(trigger, /type="button"/);
    assert.match(trigger, /class="[^"]*\bui-select-trigger\b[^"]*"/);
    assert.match(trigger, /role="combobox"/);
    assert.match(trigger, /aria-haspopup="listbox"/);
    assert.match(trigger, /aria-expanded="false"/);
    assert.match(trigger, new RegExp(`aria-controls="${id}-listbox"`));
    assert.match(trigger, new RegExp(`aria-labelledby="${id}-label ${id}-value"`));
    assert.doesNotMatch(trigger, /aria-activedescendant=/);
    assert.match(button, new RegExp(`<span id="${id}-value">${value}</span>`));
  }
  assert.doesNotMatch(html, /<(?:select|option)\b/);
  assert.doesNotMatch(html, /role="(?:listbox|option)"/);
});

test("SettingsPage renders the selected section content", () => {
  const providers = renderSettings("providers");
  assert.match(providers, /<h1 id="settings-providers-title">Providers<\/h1>/);
  assert.match(providers, /class="provider-list"/);
  assert.match(renderSettings("usage"), /<h1 id="settings-usage-title">Usage<\/h1>/);
  assert.match(renderSettings("tts"), /<h1 id="settings-tts-title">TTS<\/h1>/);
});
