import assert from "node:assert/strict";
import test from "node:test";

const { isSendKey } = await import("../../../../../frontend/src/middle-column/composer/sendKey.js");

test("Composer submission keys distinguish sending, newlines and IME confirmation", () => {
  const cases = [
    { key: "Enter", shift: false, composing: false, sends: true },
    { key: "Enter", shift: false, composing: true, sends: false },
    { key: "Enter", shift: true, composing: false, sends: false },
    { key: "a", shift: false, composing: false, sends: false },
  ];
  for (const { key, shift, composing, sends } of cases) {
    assert.equal(isSendKey(key, shift, composing), sends, JSON.stringify({ key, shift, composing }));
  }
});
