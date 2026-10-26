import assert from "node:assert/strict";
import test from "node:test";
import { createWebSearchTool, type WebSearchOptions } from "../../../agent/tools/web-search.js";

const context = { cwd: "/tmp" };
const resultBlock = (title: string, url: string, snippet = "") => `
  <div class="result results_links results_links_deep web-result">
    <div class="result__body">
      <h2 class="result__title"><a class="result__a" href="${url}">${title}</a></h2>
      <span class="result__icon"><img class="result__icon__img" src="//external-content.duckduckgo.com/ip3/example.com.ico"></span>
      <a class="result__snippet">${snippet}</a>
    </div>
  </div>`;
const html = (...blocks: string[]) => `<!doctype html><html><head><title>Search at DuckDuckGo</title></head><body><div class="results">${blocks.join("")}</div></body></html>`;
const response = (body: string, status = 200, headers: Record<string, string> = {}) => new Response(body, {
  status, headers: { "content-type": "text/html; charset=UTF-8", ...headers },
});
const withResponse = (body: string, options: Omit<WebSearchOptions, "fetch"> = {}) => createWebSearchTool({
  ...options, fetch: async () => response(body),
});

test("web_search uses public HTML and derives text and UI metadata from the same ordered results", async () => {
  let requestUrl = "";
  let requestInit: RequestInit | undefined;
  const tool = createWebSearchTool({ fetch: async (url, init) => {
    requestUrl = String(url);
    requestInit = init;
    return response(html(
      resultBlock("BrowserWindow &amp; Electron", "//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.electronjs.org%2Fdocs%2Flatest%2Fapi%2Fbrowser-window&amp;rut=provider-token", "Create <b>browser</b>\n windows.&nbsp; Main process."),
      resultBlock("Second result", "https://example.com/reference?x=1&amp;y=2"),
    ));
  } });
  const result = await tool.execute({ query: "Electron BrowserWindow 中文 & API" }, context);
  assert.equal(result.ok, true);
  assert.equal(new URL(requestUrl).origin, "https://html.duckduckgo.com");
  assert.equal(new URL(requestUrl).searchParams.get("q"), "Electron BrowserWindow 中文 & API");
  assert.equal(new Headers(requestInit?.headers).has("user-agent"), false);
  assert.equal(requestInit?.redirect, "manual");
  assert.ok(requestInit?.signal instanceof AbortSignal);
  assert.deepEqual(result.web?.pages, [
    { url: "https://www.electronjs.org/docs/latest/api/browser-window", title: "BrowserWindow & Electron", snippet: "Create browser windows. Main process." },
    { url: "https://example.com/reference?x=1&y=2", title: "Second result" },
  ]);
  for (const page of result.web!.pages) {
    assert.ok(result.output.includes(page.title));
    assert.ok(result.output.includes(page.url));
    if (page.snippet) assert.ok(result.output.includes(page.snippet));
  }
  assert.equal(result.output.includes("provider-token"), false);
  assert.equal(JSON.stringify(result.web).includes("external-content.duckduckgo.com"), false);
  assert.deepEqual(tool.recovery, { version: "1", mode: "safe", resumePlanned: false });
  assert.equal("purpose" in tool.definition.parameters.properties, false);
});

test("maxResults limits this response while preserving source order and duplicate URLs", async () => {
  const result = await withResponse(html(
    resultBlock("Z first", "https://example.com/shared"),
    resultBlock("A second", "https://example.com/shared"),
    resultBlock("B third", "https://example.com/third"),
  )).execute({ query: "query", maxResults: 2 }, context);
  assert.equal(result.ok, true);
  assert.equal(result.truncated, true);
  assert.deepEqual(result.web?.pages.map((page) => page.title), ["Z first", "A second"]);
  assert.ok(result.output.includes("first 2 of 3 results from this response"));
  assert.equal(result.output.includes("B third"), false);
});

test("only the explicit source no-results structure produces a successful empty result", async () => {
  const empty = await withResponse(html('<div class="result web-result result--no-result"><span class="no-results"><div class="no-results__message">No results found</div></span></div>'))
    .execute({ query: "missing result" }, context);
  assert.equal(empty.ok, true);
  assert.deepEqual(empty.web, { pages: [] });
  assert.equal(empty.truncated, false);
  const changed = await withResponse(html('<div class="new-layout">Search results have moved</div>')).execute({ query: "query" }, context);
  assert.equal(changed.ok, false);
  assert.equal(changed.error, "parse_failed");
  assert.equal(changed.web, undefined);
});

test("HTTP 202 and HTML challenge forms are verification failures, even when Response.ok is true", async () => {
  for (const fixture of [
    response("Accepted", 202),
    response(html('<form id="challenge-form" action="//duckduckgo.com/anomaly.js"><input name="answer"></form>')),
  ]) {
    let requests = 0;
    const result = await createWebSearchTool({ fetch: async () => { requests += 1; return fixture; } }).execute({ query: "query" }, context);
    assert.equal(result.ok, false);
    assert.equal(result.error, "verification_required");
    assert.equal(result.web, undefined);
    assert.equal(requests, 1);
  }
});

test("blocked and server-error statuses cannot become empty or successful search results", async () => {
  for (const status of [401, 403, 429, 503]) {
    const result = await createWebSearchTool({ fetch: async () => response("Service unavailable", status) }).execute({ query: "query" }, context);
    assert.equal(result.ok, false);
    assert.equal(result.error, status === 503 ? "http_error" : "blocked");
    assert.ok(result.output.includes(String(status)));
    assert.equal(result.web, undefined);
  }
});

test("invalid queries and result limits fail before any request", async () => {
  let requests = 0;
  const tool = createWebSearchTool({ fetch: async () => { requests += 1; throw new Error("Unexpected request"); } });
  for (const input of [
    {}, { query: " " }, { query: 123 }, { query: "q\0uery" }, { query: "a".repeat(501) },
    ...[0, -1, 21, 1.5, "2", Number.NaN].map((maxResults) => ({ query: "query", maxResults })),
  ]) assert.equal((await tool.execute(input, context)).error, "invalid_arguments");
  assert.equal(requests, 0);
});

test("malformed result links fail explicitly", async () => {
  for (const link of ["javascript:alert(1)", "file:///tmp/local", "//duckduckgo.com/l/?rut=missing-destination", "https://user:password@example.com/"]) {
    const result = await withResponse(html(resultBlock("Broken result", link))).execute({ query: "query" }, context);
    assert.equal(result.error, "parse_failed");
    assert.equal(result.web, undefined);
  }
});

test("redirects follow only the same HTTPS source's HTML search endpoint", async () => {
  const requested: string[] = [];
  const tool = createWebSearchTool({ fetch: async (url, init) => {
    requested.push(String(url));
    assert.equal(init?.redirect, "manual");
    return requested.length === 1
      ? response("", 302, { location: "/html/?q=redirected" })
      : response(html(resultBlock("Result", "https://example.com/")));
  } });
  assert.equal((await tool.execute({ query: "query" }, context)).ok, true);
  assert.equal(requested[1], "https://html.duckduckgo.com/html/?q=redirected");
  for (const [location, expected] of [
    ["https://example.com/html/", "blocked"],
    ["http://html.duckduckgo.com/html/", "blocked"],
    ["https://user:password@html.duckduckgo.com/html/", "blocked"],
    ["/other-endpoint", "blocked"],
    ["/anomaly.js", "verification_required"],
    ["http://[invalid", "parse_failed"],
  ]) {
    let calls = 0;
    const result = await createWebSearchTool({ fetch: async () => { calls += 1; return response("", 302, { location }); } }).execute({ query: "query" }, context);
    assert.equal(result.error, expected);
    assert.equal(calls, 1);
  }
});

test("redirect loops and missing destinations fail without uncontrolled requests", async () => {
  let calls = 0;
  const loop = createWebSearchTool({ fetch: async () => { calls += 1; return response("", 302, { location: "/html/" }); } });
  assert.equal((await loop.execute({ query: "query" }, context)).error, "blocked");
  assert.equal(calls, 4);
  const missing = createWebSearchTool({ fetch: async () => response("", 302) });
  assert.equal((await missing.execute({ query: "query" }, context)).error, "parse_failed");
});

test("both declared size and streamed response bytes enforce the response limit", async () => {
  let cancelled = 0;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new TextEncoder().encode("x".repeat(100))); },
    cancel() { cancelled += 1; },
  });
  const streamed = await createWebSearchTool({ maxResponseBytes: 64, fetch: async () => new Response(stream) }).execute({ query: "query" }, context);
  assert.equal(streamed.error, "response_too_large");
  assert.equal(cancelled, 1);
  const declared = await createWebSearchTool({ maxResponseBytes: 64, fetch: async () => response("short", 200, { "content-length": "1000" }) }).execute({ query: "query" }, context);
  assert.equal(declared.error, "response_too_large");
});

test("UTF-8 split across response chunks retains the original search text", async () => {
  const encoded = new TextEncoder().encode(html(resultBlock("中文🙂", "https://example.com/", "原始摘要")));
  const stream = new ReadableStream<Uint8Array>({ start(controller) {
    for (let offset = 0; offset < encoded.byteLength; offset += 7) controller.enqueue(encoded.slice(offset, offset + 7));
    controller.close();
  } });
  const result = await createWebSearchTool({ fetch: async () => new Response(stream) }).execute({ query: "query" }, context);
  assert.equal(result.ok, true);
  assert.equal(result.web?.pages[0]?.title, "中文🙂");
  assert.equal(result.web?.pages[0]?.snippet, "原始摘要");
});

test("cancellation prevents a request and also stops a pending response body", async () => {
  let requests = 0;
  const before = new AbortController();
  before.abort();
  const tool = createWebSearchTool({ fetch: async () => { requests += 1; throw new Error("Unexpected request"); } });
  assert.equal((await tool.execute({ query: "query" }, { ...context, signal: before.signal })).error, "cancelled");
  assert.equal(requests, 0);

  const during = new AbortController();
  let readerCancelled = false;
  let bodyRead!: () => void;
  const started = new Promise<void>((resolve) => { bodyRead = resolve; });
  const stream = new ReadableStream<Uint8Array>({ pull() { bodyRead(); }, cancel() { readerCancelled = true; } });
  const pending = createWebSearchTool({ fetch: async () => new Response(stream) }).execute({ query: "query" }, { ...context, signal: during.signal });
  await started;
  during.abort();
  assert.equal((await pending).error, "cancelled");
  assert.equal(readerCancelled, true);
});

test("a stalled fetch times out through its AbortSignal and network errors remain failures", async () => {
  let requestSignal: AbortSignal | null | undefined;
  const tool = createWebSearchTool({ timeoutMs: 10, fetch: async (_url, init) => {
    requestSignal = init?.signal;
    return new Promise<Response>((_resolve, reject) => {
      requestSignal!.addEventListener("abort", () => reject(requestSignal!.reason), { once: true });
    });
  } });
  assert.equal((await tool.execute({ query: "query" }, context)).error, "timeout");
  assert.equal(requestSignal?.aborted, true);
  const network = createWebSearchTool({ fetch: async () => { throw new Error("socket error"); } });
  assert.equal((await network.execute({ query: "query" }, context)).error, "network_error");
});

test("non-HTML responses fail explicitly", async () => {
  const result = await createWebSearchTool({ fetch: async () => response('{"results":[]}', 200, { "content-type": "application/json" }) }).execute({ query: "query" }, context);
  assert.equal(result.error, "parse_failed");
});
