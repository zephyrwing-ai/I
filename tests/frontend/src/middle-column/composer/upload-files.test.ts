import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { register, createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { build } from "vite";
import type { InputAttachmentDescriptor } from "../../../../../shell/shared/ipc.js";
import {
  applyAttachmentResult, ATTACHMENT_LIMIT_MESSAGE, formatDuration, isFileDrag,
} from "../../../../../frontend/src/middle-column/composer/upload-files/attachments.js";
import { safeAttachmentUrl } from "../../../../../frontend/src/shared/attachmentUrl.js";
import { formatBytes } from "../../../../../frontend/src/shared/format.js";

register("../../../css-module-loader.mjs", import.meta.url);
const { AttachmentCards } = await import("../../../../../frontend/src/middle-column/composer/upload-files/AttachmentCards.js");

const attachment = (id: string, extra: Partial<InputAttachmentDescriptor> = {}): InputAttachmentDescriptor => ({
  attachmentId: id, name: `${id}.txt`, mediaType: "text/plain", byteSize: 1024, ...extra,
});

test("import results retain successes and partial failures, update duplicate IDs and enforce the total limit", () => {
  const existing = Array.from({ length: 9 }, (_, index) => attachment(String(index)));
  const updated = attachment("0", { previewUrl: "attachment://0/preview" });
  const failure = { name: "locked.pdf", message: "Permission denied" };
  const result = applyAttachmentResult(existing, { attachments: [updated, attachment("9"), attachment("10")], errors: [failure] });
  assert.equal(result.attachments.length, 10);
  assert.deepEqual(result.attachments[0], updated);
  assert.deepEqual(result.errors, [failure, { name: "10.txt", message: ATTACHMENT_LIMIT_MESSAGE }]);
  assert.equal(existing[0]?.previewUrl, undefined, "the caller's draft stays immutable");
  assert.deepEqual(applyAttachmentResult(existing, { attachments: [], errors: [] }).attachments, existing, "cancel preserves the draft");
});

test("media URLs accept the local attachment scheme and blobs and reject arbitrary navigation schemes", () => {
  for (const url of ["attachment://abc/preview", "attachment://abc/original", "blob:https://app.local/123", "blob:null/123"]) {
    assert.equal(safeAttachmentUrl(url), url);
  }
  for (const url of [undefined, "", "https://example.com/pixel", "http://example.com/pixel", "//example.com/a", "file:///tmp/a.png", "data:image/svg+xml,<svg/>", "javascript:alert(1)", "attachment://user:pass@abc/preview", " attachment://abc/preview", "attachment://a/\npreview", "attachment://"]) {
    assert.equal(safeAttachmentUrl(url), undefined, String(url));
  }
});

test("file metadata formatting handles video duration, byte boundaries and absent metadata", () => {
  assert.deepEqual([0, 1023, 1024, 1024 * 1024, NaN, -1].map(formatBytes), ["0 B", "1023 B", "1.0 KB", "1.0 MB", "0 B", "0 B"]);
  assert.deepEqual([undefined, -1, NaN, Infinity, 0, 65.9, 3601].map(formatDuration), [undefined, undefined, undefined, undefined, "0:00", "1:05", "1:00:01"]);
});

test("file drags are identified during protected dragover while text drops retain their native behavior", () => {
  const data = { types: ["Files"], items: [], files: [] } as unknown as DataTransfer;
  assert.equal(isFileDrag(data), true);
  assert.equal(isFileDrag({ ...data, types: [], items: [{ kind: "file" }] } as unknown as DataTransfer), true);
  assert.equal(isFileDrag({ ...data, types: [], files: [{}] } as unknown as DataTransfer), true);
  assert.equal(isFileDrag({ ...data, types: ["text/plain", "text/html"] }), false);
});

test("cards render without document, escape names, expose optional removal, and retain video metadata", () => {
  assert.equal(typeof document, "undefined");
  const descriptors = [
    attachment("image", { name: '<img src=x onerror="alert(1)">.png', mediaType: "image/png", previewUrl: "attachment://image/preview", mediaUrl: "attachment://image/original" }),
    attachment("video", { mediaType: "video/mp4", previewUrl: "attachment://video/preview", mediaUrl: "attachment://video/original", durationSeconds: 65 }),
    attachment("file"),
  ];
  const history = renderToStaticMarkup(createElement(AttachmentCards, { attachments: descriptors }));
  assert.match(history, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;\.png/);
  assert.match(history, /aria-haspopup="dialog"/);
  assert.match(history, /upload-files-play/);
  assert.match(history, /1:05/);
  assert.equal(history.match(/class="upload-files-card is-media"/g)?.length, 2);
  assert.match(history, /class="upload-files-card is-file"/);
  assert.doesNotMatch(history, /upload-files-remove|<dialog/);
  const draft = renderToStaticMarkup(createElement(AttachmentCards, { attachments: descriptors, onRemove: () => undefined, disabled: true }));
  assert.equal(draft.match(/class="upload-files-remove(?: is-overlay)?"/g)?.length, 3);
  assert.match(draft, /class="upload-files-remove"[^>]*disabled=""/);
  assert.equal(renderToStaticMarkup(createElement(AttachmentCards, { attachments: [] })), "");
});

test("unsafe media URLs render fixed placeholders without creating remote image or video requests", () => {
  const html = renderToStaticMarkup(createElement(AttachmentCards, { attachments: [
    attachment("image", { mediaType: "image/png", previewUrl: "https://evil.example/pixel" }),
    attachment("video", { mediaType: "video/mp4", mediaUrl: "file:///tmp/private.mp4" }),
  ] }));
  assert.equal(html.match(/class="upload-files-card is-media"/g)?.length, 2);
  assert.doesNotMatch(html, /<img|<video|aria-haspopup|evil\.example|file:\/\//);
});

const projectRoot = fileURLToPath(new URL("../../../../../", import.meta.url));
const browserFixture = `
import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { useUploadFiles } from ${JSON.stringify(join(projectRoot, "frontend/src/middle-column/composer/upload-files/useUploadFiles.ts"))};
import { AttachmentCards } from ${JSON.stringify(join(projectRoot, "frontend/src/middle-column/composer/upload-files/AttachmentCards.tsx"))};
import { Composer } from ${JSON.stringify(join(projectRoot, "frontend/src/middle-column/composer/Composer.tsx"))};
import ${JSON.stringify(join(projectRoot, "frontend/src/styles.css"))};
const checks = [];
const check = (value, message) => { if (!value) throw new Error(message); checks.push(message); };
const tick = () => new Promise(resolve => setTimeout(resolve, 15));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const file = id => ({ attachmentId: id, name: id + ".txt", mediaType: "text/plain", byteSize: 42 });
const result = (...attachments) => ({ attachments, errors: [] });
const picked = [], dropped = [], unhandled = [];
let pickCalls = 0, importCalls = 0, importedFiles, uploads;
window.addEventListener("unhandledrejection", event => unhandled.push(String(event.reason)));
window.agentAPI = {
  selectAttachments: () => { pickCalls++; return picked.shift() ?? Promise.resolve(result()); },
  importAttachments: files => { importCalls++; importedFiles = files; return dropped.shift() ?? Promise.resolve(result()); },
};
const root = createRoot(document.getElementById("root"));
function Harness({ scopeKey = "a", disabled = false }) {
  uploads = useUploadFiles({ scopeKey, disabled });
  return React.createElement("div", { id: "zone", ...uploads.dropHandlers },
    React.createElement(AttachmentCards, { attachments: uploads.attachments, onRemove: uploads.removeAttachment, disabled: uploads.disabled }),
    React.createElement("textarea", { id: "text" }));
}
const render = (props = {}) => flushSync(() => root.render(React.createElement(Harness, props)));
const drag = (type, target = document.getElementById("zone"), data = null) => {
  if (!data) { data = new DataTransfer(); data.items.add(new File(["image"], "local.png", { type: "image/png" })); }
  const event = new DragEvent(type, { dataTransfer: data, bubbles: true, cancelable: true });
  target.dispatchEvent(event); return event;
};
const add = async (...attachments) => { picked.push(Promise.resolve(result(...attachments))); await uploads.pickFiles(); await tick(); };
const typeText = text => {
  const input = document.querySelector("textarea");
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(input, text);
  input.dispatchEvent(new Event("input", { bubbles: true }));
};
window.runUploadFilesRegression = async () => {
  render();
  const pending = deferred(); picked.push(pending.promise);
  const importing = uploads.pickFiles();
  check(uploads.hasPendingUpload(), "upload lock is synchronous before React rerenders");
  await uploads.pickFiles(); await tick();
  check(pickCalls === 1 && uploads.busy, "repeated picker actions share one in-flight request");
  pending.resolve({ attachments: [file("picked")], errors: [{ name: "bad.pdf", message: "Unreadable" }] });
  await importing; await tick();
  check(!uploads.busy && uploads.attachments.length === 1 && uploads.errors[0].name === "bad.pdf", "partial failures preserve prepared files and release the lock");
  const failed = deferred(); picked.push(failed.promise);
  const failing = uploads.pickFiles(); failed.reject(new Error("Picker failed"));
  await failing; await tick();
  check(!uploads.busy && uploads.errors[0].message === "Picker failed" && uploads.attachments.length === 1, "rejected imports retain the draft and surface their error");

  const stale = deferred(); picked.push(stale.promise); const oldRequest = uploads.pickFiles();
  const oldRemove = uploads.removeAttachments;
  render({ scopeKey: "b" });
  check(uploads.attachments.length === 0 && !uploads.busy && uploads.errors.length === 0, "scope changes clear draft, errors and busy state synchronously");
  render({ scopeKey: "a" });
  const fresh = deferred(); picked.push(fresh.promise); const freshRequest = uploads.pickFiles(); await tick();
  stale.resolve(result(file("stale"))); await oldRequest; await tick();
  check(uploads.busy && uploads.attachments.length === 0, "A-B-A scope changes ignore stale results without unlocking the newer upload: " + JSON.stringify({ busy: uploads.busy, attachments: uploads.attachments, pending: uploads.hasPendingUpload(), pickCalls }));
  fresh.resolve(result(file("fresh"))); await freshRequest; await tick();
  oldRemove(["fresh"]); await tick();
  check(uploads.attachments[0].attachmentId === "fresh", "consuming an old submission leaves the new scope draft intact");

  check(drag("dragenter").defaultPrevented, "file dragenter prevents file navigation");
  drag("dragenter", document.getElementById("text")); await tick();
  drag("dragleave", document.getElementById("text")); await tick();
  check(uploads.dragging, "crossing nested composer children retains drag highlight");
  drag("dragleave"); await tick();
  check(!uploads.dragging, "balanced outer dragleave resets highlight");
  drag("dragenter"); await tick(); render({ scopeKey: "a", disabled: true });
  check(!uploads.dragging, "disabling uploads hides drag highlight immediately");
  const beforeDisabledDrop = importCalls;
  check(drag("dragover").defaultPrevented && drag("drop").defaultPrevented, "disabled file dragover and drop still prevent navigation");
  await tick(); check(importCalls === beforeDisabledDrop, "disabled drops never import files");
  const text = new DataTransfer(); text.setData("text/plain", "normal text");
  check(!drag("drop", document.getElementById("text"), text).defaultPrevented, "text drops retain native insertion behavior");
  render({ scopeKey: "a" });
  drag("dragenter"); await tick();
  dropped.push(Promise.resolve({ attachments: [file("drop")], errors: [{ name: "bad-drop", message: "Unreadable" }] }));
  check(drag("drop").defaultPrevented, "enabled drops prevent file navigation"); await tick();
  check(!uploads.dragging && uploads.attachments.length === 2 && uploads.errors[0].name === "bad-drop", "picker and drop share result merging and partial error handling");
  check(importedFiles[0] instanceof File && importedFiles[0].name === "local.png", "drop passes actual Files to preload rather than reconstructing paths");
  await add(...Array.from({ length: 12 }, (_, index) => file("limit-" + index)));
  check(uploads.attachments.length === 10 && uploads.errors.length === 4, "the ten-file limit applies across picker and drop batches");
  const fullCalls = pickCalls; await uploads.pickFiles(); await tick();
  check(pickCalls === fullCalls && uploads.errors.length === 1, "full drafts reject further imports before invoking preload");

  render({ scopeKey: "composer" });
  const model = { modelOptionId: "model", displayName: "Model", available: true, imported: true, state: "saved", providerProfileId: "provider", providerName: "Provider", modelId: "model" };
  localStorage.setItem("workbench.modelOptionId", "model");
  let runRequest, steerRequest, stops = 0, accept = false;
  const props = { running: false, stopping: false, ready: true, modelOptions: [model], modelLoading: false,
    project: { projectId: "composer", displayName: "Project", canonicalPath: null },
    onRun: async request => { runRequest = request; return accept; },
    onSteer: async request => { steerRequest = request; return true; }, onStop: () => { stops++; } };
  const renderComposer = overrides => flushSync(() => root.render(React.createElement(Composer, { ...props, ...overrides })));
  renderComposer(); await tick();
  const uploading = deferred(); picked.push(uploading.promise);
  document.querySelector('[aria-label="Upload files"]').click(); await tick();
  typeText("typing during upload"); await tick();
  check(!document.querySelector("textarea").disabled && document.querySelector("textarea").value === "typing during upload", "typing stays enabled throughout attachment processing");
  check(!document.querySelector(".upload-files-status") && !document.body.textContent.includes("Preparing attachments"), "attachment processing adds no visible status copy");
  check(document.querySelector('[aria-label="Send"]').disabled, "pending processing disables Send even when the draft has text");
  document.querySelector("textarea").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  await tick(); check(!runRequest, "keyboard send is also locked while an upload is pending");
  uploading.resolve(result(file("attachment-only"))); await tick(); typeText(""); await tick();
  check(!document.querySelector('[aria-label="Send"]').disabled, "prepared attachments alone enable an idle Send");
  document.querySelector('[aria-label="Send"]').click(); await tick();
  check(runRequest.task === "" && runRequest.attachmentIds[0] === "attachment-only" && document.querySelectorAll(".upload-files-card").length === 1, "attachment-only requests submit IDs and retain the draft when declined");
  renderComposer({ running: true, activeRunId: "run" }); await tick();
  check(Boolean(document.querySelector('[aria-label="Stop run"]')), "attachments alone preserve the running Stop action");
  document.querySelector('[aria-label="Stop run"]').click(); check(stops === 1, "the existing Stop button still invokes onStop");
  typeText("steer text"); await tick(); document.querySelector('[aria-label="Send"]').click(); await tick();
  check(steerRequest.task === "steer text" && !("attachmentIds" in steerRequest) && document.querySelectorAll(".upload-files-card").length === 1, "steering remains text-only and preserves attachment drafts");
  renderComposer(); accept = true; await tick(); document.querySelector('[aria-label="Send"]').click(); await tick();
  check(document.querySelectorAll(".upload-files-card").length === 0, "accepted idle submissions consume their attachment IDs");

  render({ scopeKey: "media" });
  const url = URL.createObjectURL(new Blob(['<svg xmlns="http://www.w3.org/2000/svg" width="20" height="10"><rect width="20" height="10" fill="red"/></svg>'], { type: "image/svg+xml" }));
  await add({ ...file("image"), mediaType: "image/png", previewUrl: url, mediaUrl: url }, { ...file("video"), mediaType: "video/mp4", previewUrl: url, mediaUrl: url, durationSeconds: 65 }, file("ordinary"));
  const preview = document.querySelector(".upload-files-preview");
  const bounds = preview.getBoundingClientRect();
  check(bounds.width === 160 && bounds.height === 90 && getComputedStyle(preview.querySelector("img")).objectFit === "contain", "media preview geometry stays 160 by 90 with contained images");
  check(document.querySelector(".is-media .upload-files-footer").getBoundingClientRect().height === 36 && document.querySelector(".is-file").getBoundingClientRect().height === 42 && document.querySelector(".upload-files-remove").getBoundingClientRect().width === 28, "footers, ordinary file chips and remove controls retain the specified geometry");
  preview.focus(); preview.click(); await tick();
  const dialog = document.querySelector("dialog");
  check(dialog.open && dialog.parentElement === document.body && dialog.contains(document.activeElement), "media preview opens a modal in document.body and moves focus inside");
  dialog.querySelector("button").click(); await tick();
  check(!document.querySelector("dialog") && document.activeElement === preview, "closing the modal returns focus to its trigger");
  document.querySelectorAll("button.upload-files-preview")[1].click(); await tick();
  check(document.querySelector("dialog video").controls, "video previews expose native playback controls");
  document.querySelector("dialog button").click(); await tick();
  preview.focus(); preview.click(); await tick();
  window.previewOpener = preview;
  window.finishUploadFilesRegression = async () => {
    await tick();
    check(!document.querySelector("dialog") && document.activeElement === preview, "Escape closes the native dialog and restores trigger focus");
    preview.click(); await tick();
    uploads.removeAttachments(["image"]); await tick();
    check(!document.querySelector("dialog"), "removing the active reference closes its modal");
    await add({ ...file("image"), mediaType: "image/png", previewUrl: url, mediaUrl: url });
    check(!document.querySelector("dialog"), "re-adding the same file starts with a fresh preview selection");
    const pendingUnmount = deferred(); picked.push(pendingUnmount.promise); const unmounting = uploads.pickFiles();
    root.unmount(); pendingUnmount.reject(new Error("after unmount")); await unmounting; await tick();
    check(unhandled.length === 0, "rejected, stale and unmounted imports produce no unhandled promise rejections");
    URL.revokeObjectURL(url);
    return checks;
  };
  return checks.length;
};
window.prepareUploadScreenshot = async () => {
  document.documentElement.dataset.theme = "dark";
  const element = document.getElementById("root");
  element.style.cssText = "width:calc(100% - 48px);max-width:760px;height:auto;margin:48px auto";
  const url = URL.createObjectURL(new Blob(['<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="#eeeeee"/><rect x="76" y="16" width="168" height="148" rx="20" fill="#252525"/><circle cx="160" cy="90" r="60" fill="#ffa500"/><circle cx="160" cy="90" r="42" fill="#2400ff"/><circle cx="160" cy="90" r="24" fill="#a000ff"/></svg>'],{type:"image/svg+xml"}));
  const media = [
    {...file("recording"), name:"Screen Recording.mp4",mediaType:"video/mp4",previewUrl:url,mediaUrl:url,durationSeconds:65},
    {...file("reference"),name:"Reference.png",mediaType:"image/png",previewUrl:url,mediaUrl:url},
    file("report"),
  ];
  window.agentAPI.selectAttachments = async()=>result(...media);
  const screenshotRoot = createRoot(element);
  flushSync(()=>screenshotRoot.render(React.createElement(Composer,{running:false,stopping:false,ready:true,modelLoading:false,modelOptions:[{modelOptionId:"model",displayName:"Vision model",available:true,imported:true,state:"saved",providerProfileId:"provider",providerName:"Provider",modelId:"model"}],onRun:async()=>true,onStop:()=>{}})));
  await tick();document.querySelector('[aria-label="Upload files"]').click();await tick();
  await Promise.all(Array.from(document.querySelectorAll('img')).map(image=>image.decode()));
};
`;

test("Electron verifies upload scope guards, drag/drop, sending, media geometry and modal focus", { timeout: 40_000 }, async () => {
  const temporary = await mkdtemp(join(tmpdir(), "composer-upload-regression-"));
  try {
    await build({
      configFile: false, root: projectRoot, base: "./", logLevel: "silent",
      esbuild: { jsx: "automatic" },
      plugins: [{ name: "upload-fixture", resolveId: (id) => id === "virtual:upload-fixture" ? "\0upload-fixture.js" : undefined, load: (id) => id === "\0upload-fixture.js" ? browserFixture : undefined }],
      build: { outDir: temporary, emptyOutDir: true, rollupOptions: { input: "virtual:upload-fixture", output: { entryFileNames: "fixture.js", assetFileNames: "fixture[extname]" } } },
    });
    await writeFile(join(temporary, "index.html"), '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="./fixture.css"><div id="root"></div><script type="module" src="./fixture.js"></script>');
    await writeFile(join(temporary, "electron.cjs"), `
const { app, BrowserWindow } = require("electron");
const { writeFile } = require("node:fs/promises");
app.setPath("userData", process.argv[3]);
const timeout = setTimeout(() => app.exit(1), 25000);
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 900, height: 700, webPreferences: { offscreen: true, backgroundThrottling: false, contextIsolation: true } });
  await win.loadFile(process.argv[2]);
  await win.webContents.executeJavaScript("window.runUploadFilesRegression()");
  win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
  win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
  const checks = await win.webContents.executeJavaScript("window.finishUploadFilesRegression()");
  await win.webContents.executeJavaScript("window.prepareUploadScreenshot()");
  if (process.argv[4]) await writeFile(process.argv[4],(await win.webContents.capturePage({x:0,y:0,width:900,height:360})).toPNG());
  win.setContentSize(420,700);
  await new Promise(resolve=>setTimeout(resolve,100));
  const narrow=await win.webContents.executeJavaScript("document.documentElement.scrollWidth <= innerWidth");
  if(!narrow) throw new Error('Attachment cards overflow a narrow Composer');
  process.stdout.write("UPLOAD_CHECKS=" + JSON.stringify(checks) + "\\n");
  clearTimeout(timeout); win.destroy(); app.quit();
}).catch(error => { process.stderr.write(String(error.stack ?? error)); app.exit(1); });
`);
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const electron = createRequire(import.meta.url)("electron") as string;
    const { stdout } = await promisify(execFile)(electron, [join(temporary, "electron.cjs"), join(temporary, "index.html"), join(temporary, "profile"), process.env.UPLOAD_FILES_SCREENSHOT ?? ""], { env, timeout: 30_000, maxBuffer: 1024 * 1024 });
    const line = stdout.split("\n").find((value) => value.startsWith("UPLOAD_CHECKS="));
    assert.ok(line, stdout);
    const checks = JSON.parse(line.slice("UPLOAD_CHECKS=".length)) as string[];
    assert.ok(checks.length >= 30, checks.join("\n"));
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
