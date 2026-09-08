import assert from "node:assert/strict";
import test from "node:test";

const { isSendKey } = await import("../../../../../frontend/src/middle-column/composer/sendKey.js");

test("Enter 未按 Shift 且非组字状态时进入提交语义", () => {
  assert.equal(isSendKey("Enter", false, false), true);
});

test("Enter 未按 Shift 且组字状态时进入候选确认语义", () => {
  assert.equal(isSendKey("Enter", false, true), false);
});

test("Shift 与 Enter 组合时进入换行语义", () => {
  assert.equal(isSendKey("Enter", true, false), false);
});

test("非 Enter 键进入普通输入语义", () => {
  assert.equal(isSendKey("a", false, false), false);
});
