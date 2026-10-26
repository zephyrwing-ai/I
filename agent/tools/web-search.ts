import { parseHTML } from "linkedom";
import type { ToolDef } from "../model/types.js";
import type { RegisteredTool, ToolResult } from "./types.js";
import { normalizeWebUrl, readWebToolMetadata, type WebPage } from "./web-result.js";

const SEARCH_URL = "https://html.duckduckgo.com/html/";
const DEFAULT_RESULTS = 8;
const MAX_RESULTS = 20;
const MAX_QUERY_LENGTH = 500;
const MAX_REDIRECTS = 3;

export interface WebSearchOptions {
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

export const WEB_SEARCH_TOOL: ToolDef = {
  name: "web_search",
  description: "Search the public web using DuckDuckGo's non-JavaScript results. Returns titles, URLs and search snippets in source order; snippets are not full page content.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "Web search query, up to 500 characters" },
      maxResults: { type: "integer", description: "Maximum results to return (default 8, range 1–20)" },
    },
    required: ["query"],
  },
};

class SearchError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

function failure(error: string, output: string): ToolResult {
  return { ok: false, output, returncode: -1, truncated: false, error };
}

function normalizedText(value: string | null): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function resultUrl(href: string | null): string | undefined {
  if (!href) return undefined;
  try {
    const link = new URL(href, SEARCH_URL);
    if (["duckduckgo.com", "www.duckduckgo.com", "html.duckduckgo.com"].includes(link.hostname)
      && link.pathname === "/l/") return normalizeWebUrl(link.searchParams.get("uddg"));
    return normalizeWebUrl(link.href);
  } catch {
    return undefined;
  }
}

function parseResults(html: string): WebPage[] {
  const { document } = parseHTML(html);
  if (document.querySelector("#challenge-form, #img-form, .anomaly-modal, [action*='anomaly.js']")) {
    throw new SearchError("verification_required", "DuckDuckGo requires verification. Search results were not retrieved.");
  }
  const blocks = [...document.querySelectorAll(".result.web-result:not(.result--no-result)")];
  const empty = document.querySelector(".result--no-result .no-results");
  if (blocks.length === 0 && empty) return [];
  if (blocks.length === 0 || empty) {
    throw new SearchError("parse_failed", "The search response did not contain the expected result structure; it was not treated as zero results.");
  }
  return blocks.map((block) => {
    const anchor = block.querySelector(".result__a");
    const title = normalizedText(anchor?.textContent ?? null);
    const url = resultUrl(anchor?.getAttribute("href") ?? null);
    if (!title || !url) throw new SearchError("parse_failed", "A search result was missing a usable title or HTTP(S) URL.");
    const snippet = normalizedText(block.querySelector(".result__snippet")?.textContent ?? null);
    return { url, title, ...(snippet ? { snippet } : {}) };
  });
}

async function requestSearch(request: typeof globalThis.fetch, url: URL, signal: AbortSignal): Promise<Response> {
  for (let redirects = 0; ; redirects += 1) {
    signal.throwIfAborted();
    const response = await request(url.href, { signal, redirect: "manual", headers: { Accept: "text/html" } });
    if (signal.aborted) {
      await response.body?.cancel().catch(() => {});
      signal.throwIfAborted();
    }
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    await response.body?.cancel().catch(() => {});
    if (redirects >= MAX_REDIRECTS) throw new SearchError("blocked", "The search source exceeded the redirect limit.");
    const location = response.headers.get("location");
    if (!location) throw new SearchError("parse_failed", "The search source returned a redirect without a destination.");
    let next: URL;
    try { next = new URL(location, url); } catch { throw new SearchError("parse_failed", "The search source returned an invalid redirect."); }
    if (next.origin !== new URL(SEARCH_URL).origin || next.username || next.password) {
      throw new SearchError("blocked", "The search source redirected outside its allowed HTTPS origin.");
    }
    if (/anomaly|challenge|captcha/i.test(next.pathname)) {
      throw new SearchError("verification_required", "DuckDuckGo requires verification. Search results were not retrieved.");
    }
    if (next.pathname !== "/html/" && next.pathname !== "/html") {
      throw new SearchError("blocked", "The search source redirected outside its HTML search endpoint.");
    }
    url = next;
  }
}

async function readBoundedText(response: Response, maxBytes: number, signal: AbortSignal): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) throw new SearchError("parse_failed", "The search response was empty.");
  const cancel = (): void => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    const declaredLength = response.headers.get("content-length");
    if (declaredLength && /^\d+$/.test(declaredLength) && Number(declaredLength) > maxBytes) {
      throw new SearchError("response_too_large", "The search response exceeded the byte limit.");
    }
    const decoder = new TextDecoder();
    const chunks: string[] = [];
    let bytes = 0;
    while (true) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) throw new SearchError("response_too_large", "The search response exceeded the byte limit.");
      chunks.push(decoder.decode(value, { stream: true }));
    }
    chunks.push(decoder.decode());
    return chunks.join("");
  } finally {
    signal.removeEventListener("abort", cancel);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** The source adapter owns parsing; Runtime owns tool execution, history and user cancellation. */
export function createWebSearchTool(options: WebSearchOptions = {}): RegisteredTool {
  const request = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 15_000;
  const maxResponseBytes = options.maxResponseBytes ?? 1_048_576;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || !Number.isSafeInteger(maxResponseBytes) || maxResponseBytes <= 0) {
    throw new Error("Web search timeout and response byte limit must be positive safe integers.");
  }
  return {
    definition: WEB_SEARCH_TOOL,
    recovery: { version: "1", mode: "safe", resumePlanned: false },
    async execute(input, context): Promise<ToolResult> {
      if (context.signal?.aborted) return failure("cancelled", "Web search was cancelled.");
      if (typeof input.query !== "string" || !input.query.trim() || input.query.length > MAX_QUERY_LENGTH || input.query.includes("\0")) {
        return failure("invalid_arguments", "Tool parameter query must contain 1–500 characters of search text.");
      }
      if (input.maxResults !== undefined && (typeof input.maxResults !== "number" || !Number.isSafeInteger(input.maxResults)
        || input.maxResults < 1 || input.maxResults > MAX_RESULTS)) {
        return failure("invalid_arguments", "Tool parameter maxResults must be an integer from 1 to 20.");
      }
      const query = normalizedText(input.query);
      const maxResults = (input.maxResults as number | undefined) ?? DEFAULT_RESULTS;
      const timeout = new AbortController();
      const signal = context.signal ? AbortSignal.any([context.signal, timeout.signal]) : timeout.signal;
      const timer = setTimeout(() => timeout.abort(), timeoutMs);
      try {
        const url = new URL(SEARCH_URL);
        url.searchParams.set("q", query);
        const response = await requestSearch(request, url, signal);
        if (signal.aborted) {
          await response.body?.cancel().catch(() => {});
          signal.throwIfAborted();
        }
        if (response.status === 202) {
          await response.body?.cancel().catch(() => {});
          return failure("verification_required", "DuckDuckGo requires verification. Search results were not retrieved.");
        }
        if (!response.ok) {
          await response.body?.cancel().catch(() => {});
          return failure([401, 403, 429].includes(response.status) ? "blocked" : "http_error", `The search source returned HTTP ${response.status}; search results were not retrieved.`);
        }
        const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
        if (contentType && !contentType.includes("text/html") && !contentType.includes("application/xhtml+xml")) {
          await response.body?.cancel().catch(() => {});
          return failure("parse_failed", "The search source returned an unexpected content type.");
        }
        const pages = parseResults(await readBoundedText(response, maxResponseBytes, signal));
        signal.throwIfAborted();
        const web = readWebToolMetadata({ pages: pages.slice(0, maxResults) });
        if (!web) throw new SearchError("parse_failed", "Search result metadata did not match the expected format.");
        const rows = web.pages.map((page, index) => `${index + 1}. ${page.title}\nURL: ${page.url}${page.snippet ? `\nSnippet: ${page.snippet}` : ""}`);
        const truncated = pages.length > web.pages.length;
        const output = [
          "Search source: DuckDuckGo HTML",
          `Query: ${query}`,
          rows.length ? rows.join("\n\n") : "No results were returned by the search source.",
          ...(truncated ? [`Showing the first ${web.pages.length} of ${pages.length} results from this response.`] : []),
        ].join("\n\n");
        return { ok: true, output, returncode: 0, truncated, web };
      } catch (error) {
        if (context.signal?.aborted) return failure("cancelled", "Web search was cancelled.");
        if (timeout.signal.aborted) return failure("timeout", "The web search request timed out.");
        if (error instanceof SearchError) return failure(error.code, error.message);
        return failure("network_error", "The web search request failed before results could be retrieved.");
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
