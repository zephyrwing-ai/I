import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { build } from "vite";

const projectRoot = fileURLToPath(new URL("../../../../../", import.meta.url));
const fixture = `
import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { AssistantMessage } from ${JSON.stringify(join(projectRoot, "frontend/src/middle-column/message-stream/AssistantMessage.tsx"))};
import ${JSON.stringify(join(projectRoot, "frontend/src/styles.css"))};
import ${JSON.stringify(join(projectRoot, "frontend/src/middle-column/message-stream/message-stream.css"))};
const root = createRoot(document.getElementById("root"));
const tick = () => new Promise(resolve => setTimeout(resolve, 30));
const check = (value, message) => { if (!value) throw new Error(message); };
let generation = 0;
function render(result) {
  const tool = { toolCallId: "search", name: "web_search", input: { query: "Electron official docs", purpose: "核对官方资料" }, status: "completed", result };
  const run = { runId: "run", projectId: null, source: "live", inputs: { user: { inputId: "user", task: "搜索官方资料", at: 1, status: "applied" } }, pendingInputIds: [], timeline: [{ kind: "user", inputId: "user" }], status: "completed", turns: { turn: { turnId: "turn", turnOrdinal: 1, status: "completed", assistantContent: "", reasoningContent: "", toolOrder: ["search"], tools: { search: tool } } }, outputFileOrder: [], outputFiles: {} };
  flushSync(() => root.render(React.createElement(AssistantMessage, { key: ++generation, run, anchorInputId: "user", turnIds: ["turn"] })));
}
async function openRow() {
  document.querySelector(".run-work-toggle").click(); await tick();
  document.querySelector(".turn-action-fold").click(); await tick();
  document.querySelector(".tool-fold").click(); await tick();
}
window.runWebSearchRegression = async () => {
  const searchResult = { ok: true, output: "FULL SEARCH OUTPUT", returncode: 0, truncated: false, web: { pages: [
    { url: "https://www.electronjs.org/docs/latest/", title: "Electron Documentation", snippet: "Source snippet stays in the tool result" },
    { url: "https://example.com/page", title: "<img src=x onerror=alert(1)>" },
    { url: "javascript:alert(1)", title: "Unsafe navigation" },
  ] } };
  render(searchResult);
  check(document.querySelector(".tool-fold").getAttribute("aria-expanded") === "false", "single search starts collapsed");
  check(!document.querySelector(".tool-web-source"), "sources mount only after expansion");
  await openRow();
  const links = Array.from(document.querySelectorAll(".tool-web-source"));
  check(links.length === 2, "only HTTP source links are rendered");
  check(links[0].href === "https://www.electronjs.org/docs/latest/", "the original source URL is retained");
  check(links[0].querySelector(".tool-web-domain").textContent === "electronjs.org", "the source domain is shown");
  check(links[1].querySelector(".tool-web-title").textContent === "<img src=x onerror=alert(1)>", "source titles remain escaped plain text");
  check(!links.some(link => link.closest("button")), "links and disclosure buttons are separate controls");
  check(links.every(link => link.target === "_blank" && link.rel === "noopener noreferrer"), "source links retain the app external-link contract");
  check(!document.body.textContent.includes("FULL SEARCH OUTPUT") && !document.body.textContent.includes("Source snippet stays"), "expanded sources keep a concise list");
  links[0].addEventListener("click", event => event.preventDefault());
  links[0].click(); await tick();
  check(document.querySelector(".tool-fold").getAttribute("aria-expanded") === "true", "clicking a source leaves the disclosure open");
  links[0].querySelector("img")?.dispatchEvent(new Event("error")); await tick();
  check(links[0].firstElementChild.tagName.toLowerCase() === "svg", "unavailable favicons use the generic globe");
  check(links.every(link => link.scrollWidth <= link.clientWidth + 1), "long titles stay within a narrow message column");
  document.querySelector(".tool-fold").click(); await tick();
  check(!document.querySelector(".tool-web-source"), "collapsing the row releases its sources");
  render({ ok: true, output: "", returncode: 0, truncated: false, web: { pages: [] } });
  await openRow();
  check(document.querySelector(".tool-status").textContent === "0 个结果", "successful empty search shows its actual count");
  check(document.querySelector(".tool-web-empty").textContent === "本次搜索没有找到结果。", "empty search explains its outcome");
  render({ ok: false, output: "", returncode: -1, truncated: false, error: "search_unavailable" });
  check(document.querySelector(".tool-error").textContent === "执行失败", "failed search retains the standard failure marker");
  await openRow();
  check(!document.querySelector(".tool-web-empty") && !document.querySelector(".tool-status"), "a failure is distinct from zero results");
  check(document.querySelector(".tool-detail").textContent.includes("search_unavailable"), "expanded failure retains the recorded error");
  render({ ...searchResult, web: { pages: [searchResult.web.pages[0], { url: "https://github.com/mozilla/readability", title: "Mozilla Readability" }] } });
  await openRow();
  return true;
};
`;

test("web search sources retain disclosure behavior, safe links and empty/error states in Electron", { timeout: 40_000 }, async () => {
  const temporary = await mkdtemp(join(tmpdir(), "web-search-ui-"));
  try {
    await build({
      configFile: false, root: projectRoot, base: "./", logLevel: "silent", esbuild: { jsx: "automatic" },
      plugins: [{ name: "web-search-fixture", resolveId: (id) => id === "virtual:web-search-fixture" ? "\0web-search-fixture.jsx" : undefined, load: (id) => id === "\0web-search-fixture.jsx" ? fixture : undefined }],
      build: { outDir: temporary, emptyOutDir: true, rollupOptions: { input: "virtual:web-search-fixture", output: { entryFileNames: "fixture.js", assetFileNames: "fixture[extname]" } } },
    });
    await writeFile(join(temporary, "index.html"), '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="./fixture.css"><style>#root{width:320px}</style><div id="root"></div><script type="module" src="./fixture.js"></script>');
    await writeFile(join(temporary, "electron.cjs"), `
const { app, BrowserWindow, session } = require("electron");
const { writeFile } = require("node:fs/promises");
app.setPath("userData", process.argv[3]);
const timeout = setTimeout(() => app.exit(1), 25000);
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest({ urls: ["http://*/*", "https://*/*"] }, (_details, callback) => callback({ cancel: true }));
  const win = new BrowserWindow({ show: false, width: 420, height: 700, webPreferences: { offscreen: true, backgroundThrottling: false, contextIsolation: true } });
  await win.loadFile(process.argv[2]);
  const result = await win.webContents.executeJavaScript("window.runWebSearchRegression()");
  if (process.argv[4]) {
    win.setContentSize(800, 320);
    await win.webContents.executeJavaScript("document.getElementById('root').style.width = '760px'; new Promise(resolve => setTimeout(resolve, 250))");
    await writeFile(process.argv[4], (await win.webContents.capturePage({ x: 0, y: 0, width: 800, height: 240 })).toPNG());
  }
  process.stdout.write("WEB_SEARCH_UI=" + JSON.stringify(result) + "\\n");
  clearTimeout(timeout); win.destroy(); app.quit();
}).catch(error => { process.stderr.write(String(error.stack ?? error)); app.exit(1); });
`);
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const electron = createRequire(import.meta.url)("electron") as string;
    const { stdout } = await promisify(execFile)(electron, [join(temporary, "electron.cjs"), join(temporary, "index.html"), join(temporary, "profile"), process.env.WEB_SEARCH_UI_SCREENSHOT ?? ""], { env, timeout: 30_000, maxBuffer: 1024 * 1024 });
    assert.ok(stdout.includes("WEB_SEARCH_UI=true"), stdout);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
