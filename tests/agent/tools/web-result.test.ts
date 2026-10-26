import assert from "node:assert/strict";
import test from "node:test";
import { readToolResult } from "../../../agent/tools/result.js";
import { normalizeWebUrl, readWebToolMetadata } from "../../../agent/tools/web-result.js";
import { readPublicToolResult, toPublicToolResult } from "../../../shell/shared/tool-result.js";

const outcome = { ok: true, output: "Search results", returncode: 0, truncated: false };

test("web source metadata preserves order and projects only public fields", () => {
  const web = { pages: [
    { url: "https://example.org/docs", title: "Docs", snippet: "Original search snippet", privateNote: "discard" },
    { url: "http://example.net/", title: "Example", faviconUrl: "https://example.net/favicon.ico" },
  ], privateNote: "discard" };
  const publicResult = toPublicToolResult({ ...outcome, web });
  assert.deepEqual(publicResult.web, { pages: [
    { url: "https://example.org/docs", title: "Docs", snippet: "Original search snippet" },
    { url: "http://example.net/", title: "Example", faviconUrl: "https://example.net/favicon.ico" },
  ] });
  assert.deepEqual(readPublicToolResult(publicResult), publicResult);
  assert.ok(readToolResult({ ...outcome, web }));
  assert.deepEqual(readWebToolMetadata({ pages: [] }), { pages: [] });
});

test("malformed web metadata is rejected at live and stored outcome boundaries", () => {
  for (const web of [
    null, [], {}, { pages: "not a list" }, { pages: [null] },
    { pages: [{ url: "javascript:alert(1)", title: "Unsafe" }] },
    { pages: [{ url: "https://user:secret@example.com/", title: "Credentials" }] },
    { pages: [{ url: "https://example.com/", title: "" }] },
    { pages: [{ url: "https://example.com/", title: "Example", snippet: 42 }] },
    { pages: [{ url: "https://example.com/", title: "Example", faviconUrl: "data:image/png;base64,AA" }] },
    { pages: Array.from({ length: 21 }, () => ({ url: "https://example.com/", title: "Example" })) },
  ]) {
    assert.equal(readWebToolMetadata(web), undefined);
    assert.equal(readToolResult({ ...outcome, web }), undefined);
    assert.equal(readPublicToolResult({ ...outcome, web }), undefined);
  }
});

test("legacy outcomes retain their public shape and URL validation rejects active schemes", () => {
  assert.deepEqual(readPublicToolResult(outcome), toPublicToolResult(outcome));
  assert.equal(Object.hasOwn(toPublicToolResult(outcome), "web"), false);
  assert.equal(normalizeWebUrl("HTTPS://Example.COM/docs"), "https://example.com/docs");
  for (const value of [undefined, "file:///etc/passwd", "data:text/html,test", "https://example.com/\nother", "not a URL"]) {
    assert.equal(normalizeWebUrl(value), undefined);
  }
});
