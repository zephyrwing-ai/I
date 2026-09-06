import assert from "node:assert/strict";
import test from "node:test";
import { stripStreamThinking } from "../../../agent/model/openai.js";

/** 按顺序喂入流式分片，返回拼接后的 text/thinking；endOfStream 时收尾。 */
function stream(chunks: string[], endOfStream = false): { text: string; thinking: string } {
  let held = "";
  let text = "";
  let thinking = "";
  for (let i = 0; i < chunks.length; i += 1) {
    const cleaned = stripStreamThinking(chunks[i], held, endOfStream && i === chunks.length - 1);
    text += cleaned.text;
    thinking += cleaned.thinking;
    held = cleaned.pending;
  }
  return { text, thinking };
}

test("strips a complete <thinking> block from the text stream", () => {
  const { text, thinking } = stream(["a<thinking>think</thinking> b"]);
  assert.equal(text, "a b");
  assert.equal(thinking, "think");
});

test("handles tags split across stream chunks", () => {
  const { text, thinking } = stream(["a<think", "ing>x</th", "inking> b"]);
  assert.equal(text, "a b");
  assert.equal(thinking, "x");
});

test("removes DSML markers from the text stream", () => {
  const { text } = stream(["a</| | DSML | | parameter>b"]);
  assert.equal(text, "ab");
});

test("holds an open thinking block until its closing tag arrives", () => {
  const { text, thinking } = stream(["c<thinking>d", "e</thinking>f"]);
  assert.equal(text, "cf");
  assert.equal(thinking, "de");
});

test("recovers an unclosed thinking block at end of stream", () => {
  const { text, thinking } = stream(["<thinking>abc"], true);
  assert.equal(text, "");
  assert.equal(thinking, "abc");
});

test("releases plain text containing < but no > at end of stream", () => {
  const { text } = stream(["1 < 2"], true);
  assert.equal(text, "1 < 2");
});

test("drops stray thinking and DSML tag fragments", () => {
  const { text } = stream(["a</thinking>b", "</| | DSML | | par"], true);
  assert.equal(text, "ab");
});

test("extracts multiple thinking blocks", () => {
  const { text, thinking } = stream(["<thinking>1</thinking>m<thinking>2</thinking>"]);
  assert.equal(text, "m");
  assert.equal(thinking, "1\n2");
});
