import assert from "node:assert/strict";
import test from "node:test";
import { parseUiPreferences, resolveAppearance } from "../../../../../frontend/src/shared/preferences/uiPreferences";
import { translate } from "../../../../../frontend/src/shared/i18n";

test("UI preferences restore validated values and recover each invalid field independently", () => {
  const defaults = { appearance: "system", language: "en" };
  for (const raw of [null, "{", "null", "42", "[]"]) assert.deepEqual(parseUiPreferences(raw), defaults);
  assert.deepEqual(parseUiPreferences('{"appearance":"dark","language":"zh-CN"}'), { appearance: "dark", language: "zh-CN" });
  assert.deepEqual(parseUiPreferences('{"appearance":"invalid","language":"zh-CN"}'), { appearance: "system", language: "zh-CN" });
  assert.deepEqual(parseUiPreferences('{"appearance":"light","language":"invalid"}'), { appearance: "light", language: "en" });
});

test("only System appearance follows the operating system", () => {
  assert.equal(resolveAppearance("system", true), "dark");
  assert.equal(resolveAppearance("system", false), "light");
  assert.equal(resolveAppearance("light", true), "light");
  assert.equal(resolveAppearance("dark", false), "dark");
});

test("UI translations preserve unknown source messages and interpolate only provided parameters", () => {
  assert.equal(translate("en", "General"), "General");
  assert.equal(translate("zh-CN", "General"), "通用");
  assert.equal(translate("zh-CN", "Refresh {name} models", { name: "DeepSeek" }), "刷新 DeepSeek 的模型");
  assert.equal(translate("en", "Selected {selected}/{total} models", { selected: 1, total: 2 }), "Selected 1/2 models");
  assert.equal(translate("zh-CN", "Unknown backend error"), "Unknown backend error");
  assert.equal(translate("zh-CN", "constructor"), "constructor");
  assert.equal(translate("zh-CN", "Delete {name}"), "删除 {name}");
});
