import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const styles = readFileSync(fileURLToPath(new URL("../../../frontend/src/styles.css", import.meta.url)), "utf8");
const composerStyles = readFileSync(
  fileURLToPath(new URL("../../../frontend/src/middle-column/composer/Composer.css", import.meta.url)),
  "utf8",
);
const messageStyles = readFileSync(
  fileURLToPath(new URL("../../../frontend/src/middle-column/message-stream/message-stream.css", import.meta.url)),
  "utf8",
);

function ruleContains(source: string, selector: string, declaration: string): boolean {
  const ruleStart = source.indexOf(`${selector} {`);
  if (ruleStart < 0) return false;
  const ruleEnd = source.indexOf("}", ruleStart);
  return ruleEnd >= 0 && source.slice(ruleStart, ruleEnd).includes(declaration);
}

test("workbench uses the soft warm theme and a neutral gray interaction accent", () => {
  assert.match(styles, /--bg:\s*#f7f3ee;/i);
  assert.match(styles, /--surface:\s*#fffcf8;/i);
  assert.match(styles, /--surface-secondary:\s*#f1eee8;/i);
  assert.match(styles, /--surface-bubble:\s*#eee9df;/i);
  assert.match(styles, /--accent:\s*#5a5a5a;/i);
  assert.match(styles, /--selection:\s*#5a5a5a24;/i);
  assert.match(styles, /--selection-strong:\s*#5a5a5a38;/i);
  assert.match(styles, /--focus-ring:\s*#5a5a5a2e;/i);
  assert.match(styles, /--focus-ring-strong:\s*#5a5a5a38;/i);
  assert.match(styles, /--hover:\s*#5a5a5a14;/i);
  assert.doesNotMatch(styles, /#5578e8/i);
});

test("dialog and preview surfaces follow the shared warm surface tokens", () => {
  assert.equal(ruleContains(styles, ".config-floating", "background: var(--surface);"), true);
  assert.equal(ruleContains(styles, ".output-preview", "background: var(--surface);"), true);
  assert.equal(ruleContains(styles, ".search-popover", "background: var(--surface);"), true);
  assert.equal(ruleContains(composerStyles, ".composer-shell", "background: var(--surface);"), true);
  assert.equal(ruleContains(composerStyles, ".composer-shell", "border-radius: 16px;"), true);
  assert.equal(ruleContains(messageStyles, ".markdown pre", "border-radius: 16px;"), true);
  assert.equal(ruleContains(composerStyles, ".model-popover", "background: var(--surface);"), true);
  assert.doesNotMatch(styles, /background:\s*(?:white|#fff(?:fff)?);/i);
  assert.doesNotMatch(composerStyles, /background:\s*(?:white|#fff(?:fff)?);/i);
});

test("model messages fill the shared content column while user messages stay right-aligned", () => {
  assert.equal(ruleContains(messageStyles, ".stream-content", "padding: 30px 0;"), true);
  assert.equal(ruleContains(messageStyles, ".model-message", "width: 100%;"), true);
  assert.equal(ruleContains(messageStyles, ".model-text", "width: 100%; max-width: none;"), true);
  assert.equal(ruleContains(messageStyles, ".think-block", "width: 100%; max-width: none;"), true);
  assert.equal(ruleContains(messageStyles, ".user-message-row", "width: 100%;"), true);
  assert.equal(ruleContains(messageStyles, ".user-message-group", "width: fit-content;"), true);
  assert.equal(ruleContains(messageStyles, ".user-message-group", "max-width: 76%;"), true);
});
