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
const browserFixture = String.raw`
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
const until = async (predicate, message) => {
  const deadline = performance.now() + 2000;
  while (!predicate()) {
    if (performance.now() > deadline) throw new Error("Timed out: " + message);
    await tick();
  }
};
const enter = () => document.querySelector("textarea").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));

async function verifyComposerDrafts(renderComposer, props) {
  const requests = [], acknowledgements = [];
  const alternative = { ...props.modelOptions[0], modelOptionId: "alternative", modelId: "alternative", displayName: "Other model" };
  const draftProps = { modelOptions: [...props.modelOptions, alternative], onRun: request => {
    requests.push(request);
    const ack = acknowledgements.shift();
    if (!ack) throw new Error("Unexpected submission: " + JSON.stringify(request));
    return ack.promise;
  } };
  const show = async (projectId, overrides = {}) => {
    renderComposer({ ...draftProps, project: { projectId, displayName: projectId ?? "I", canonicalPath: null }, ...overrides });
    await tick();
  };
  const text = () => document.querySelector("textarea").value;
  const cards = () => document.querySelectorAll(".upload-files-card").length;
  await show("draft-a");
  const input = document.querySelector("textarea");
  const picker = document.getElementById("composer-model");
  picker.click();
  await until(() => document.querySelector('[role="option"][data-value="alternative"]'), "alternative model option");
  document.querySelector('[role="option"][data-value="alternative"]').click(); await tick();
  check(picker.value === "alternative", "the draft regression selects a model through the real combobox");
  const longDraft = Array.from({ length: 30 }, (_, index) => "Project A line " + index).join("\n");
  typeText(longDraft); await tick();
  check(input.getBoundingClientRect().height === 180 && getComputedStyle(input).overflowY === "auto", "long project drafts reach the textarea height cap and scroll");
  picked.push(Promise.resolve(result(file("draft-a-file"))));
  document.querySelector('[aria-label="Upload files"]').click();
  await until(() => cards() === 1, "project A attachment");
  await show("draft-a", { project: { projectId: "draft-a", displayName: "Renamed A", canonicalPath: "/renamed/a", pinned: true } });
  check(text() === longDraft && cards() === 1, "metadata changes for the same project retain its text and prepared attachments");
  await show("draft-b");
  check(text() === "" && cards() === 0 && !input.disabled, "a new project starts with an empty editable text draft and clears attachments");
  const emptyHeight = input.getBoundingClientRect().height;
  check(emptyHeight > 0 && emptyHeight < 180 && getComputedStyle(input).overflowY === "hidden", "switching a long draft to an empty scope restores the compact textarea height");
  typeText("B draft"); await tick();
  await show(null); check(text() === "", "the null project scope starts with its own empty draft");
  typeText("Ordinary draft"); await tick();
  await show("draft-a");
  check(text() === longDraft && input.getBoundingClientRect().height === 180 && cards() === 0, "returning to A restores long text and its measured height while attachments stay cleared");
  await show("draft-b"); check(text() === "B draft", "A-B-null-A-B restores B text");
  await show(null); check(text() === "Ordinary draft", "returning to null restores the ordinary draft");
  check(document.querySelector("textarea") === input && document.getElementById("composer-model") === picker && picker.value === "alternative", "scope and metadata changes retain the textarea DOM, model combobox DOM and selected model");

  await show("draft-a"); typeText("  A submitted  "); await tick();
  const ackA = deferred(); acknowledgements.push(ackA);
  enter(); enter(); enter(); await tick();
  check(requests.length === 1 && requests[0].task === "A submitted" && requests[0].projectId === "draft-a" && requests[0].modelOptionId === "alternative", "repeated synchronous Enter events submit once with the source project and selected model");
  check(input.disabled && document.querySelector('[aria-label="Send"]').disabled, "A retains its pending submission state while waiting for ACK");
  await show("draft-b");
  check(!input.disabled && text() === "B draft", "A's pending submission leaves B editable with B's own draft");
  const ackB = deferred(); acknowledgements.push(ackB); enter(); await tick();
  check(requests.length === 2 && requests[1].projectId === "draft-b", "B can submit independently while A is awaiting ACK");
  await show(null);
  check(!input.disabled && text() === "Ordinary draft", "pending project submissions leave the null scope editable");
  typeText("Ordinary edited during ACK"); await tick();
  ackB.resolve(true); await tick();
  check(text() === "Ordinary edited during ACK" && !input.disabled, "B's late ACK preserves the visible null draft and its editing state");
  await show("draft-b"); check(text() === "" && !input.disabled, "an accepted ACK clears its unchanged source draft even while that scope is hidden");
  typeText("B new text"); await tick();
  const editWhilePending = { id: "edit-pending-a", projectId: "draft-a", text: "A restored edit" };
  await show("draft-a", { restoreDraft: editWhilePending });
  const revisedA = "  A submitted  \nA restored edit";
  check(input.disabled && text() === revisedA, "returning to pending A restores its submit lock and allows an explicit restore to advance its text revision");
  await show("draft-b");
  picked.push(Promise.resolve(result(file("draft-b-file"))));
  document.querySelector('[aria-label="Upload files"]').click();
  await until(() => cards() === 1, "new B attachment");
  ackA.resolve(true); await tick();
  check(text() === "B new text" && cards() === 1 && !input.disabled, "A's late ACK preserves B's current text, attachment and editing state");
  await show("draft-a");
  check(text() === revisedA && !input.disabled, "the old accepted ACK releases A's lock and preserves text changed after submission");
  const declined = deferred(); acknowledgements.push(declined); enter(); await tick(); declined.resolve(false); await tick();
  check(text() === revisedA && !input.disabled, "a declined submission preserves the full source text and releases its submission gate");
  const ordinaryAck = deferred(); acknowledgements.push(ordinaryAck);
  await show(null); enter(); await tick();
  check(requests.at(-1).projectId === null && input.disabled, "ordinary submissions explicitly carry projectId null and own a separate pending gate");
  await show("draft-b"); typeText("B after null submit"); await tick();
  ordinaryAck.resolve(true); await tick();
  check(text() === "B after null submit", "a late null-scope ACK leaves project text intact");
  await show(null); check(text() === "", "an accepted null-scope ACK consumes only the ordinary text draft");

  const restoreA = { id: "restore-explicit-a", projectId: "draft-a", text: "Recovered A" };
  await show("draft-b", { restoreDraft: restoreA });
  check(text() === "B after null submit", "a restore delivered while B is visible targets its explicit A source");
  await show("draft-a", { restoreDraft: { ...restoreA } });
  const restoredA = revisedA + "\nRecovered A";
  check(text() === restoredA, "the offscreen restored text appears when its source project becomes active");
  typeText(restoredA + "\nmanual edit"); await tick();
  await show("draft-b", { restoreDraft: { ...restoreA } });
  await show("draft-a", { restoreDraft: { ...restoreA } });
  check(text() === restoredA + "\nmanual edit", "one restore id is consumed once across A-B-A and reconstructed restore objects");
  const restoreOrdinary = { id: "restore-explicit-null", projectId: null, text: "Recovered ordinary" };
  await show("draft-a", { restoreDraft: restoreOrdinary });
  check(text() === restoredA + "\nmanual edit", "a null-targeted restore preserves the visible project draft");
  await show(null, { restoreDraft: { ...restoreOrdinary } });
  check(text() === "Recovered ordinary", "null-targeted restores use the ordinary draft and deduplicate rebuilt objects");
  await show("draft-b", { restoreDraft: { ...restoreA, projectId: "draft-b" } });
  check(text() === "B after null submit", "an already consumed restore id stays consumed even if its project field changes");
  check(document.querySelector("textarea") === input && document.getElementById("composer-model") === picker && picker.value === "alternative", "submissions, late ACKs and restores preserve the mounted input and model selection");
}

async function verifyVoiceDrafts(renderComposer, props) {
  const originalAudioContext = window.AudioContext;
  const originalMedia = Object.getOwnPropertyDescriptor(navigator, "mediaDevices");
  const voiceCalls = [], cancellations = [], streams = [], contexts = [], microphoneRequests = [];
  const originalTranscribe = window.agentAPI.transcribeVoice;
  const originalCancel = window.agentAPI.cancelVoiceTranscription;
  const makeStream = () => {
    const track = { onended: null, stopped: false, stop() { this.stopped = true; } };
    const stream = { getTracks: () => [track], getAudioTracks: () => [track], track };
    streams.push(stream); return stream;
  };
  // Control only device acquisition, PCM delivery and IPC; keep Composer and useVoiceInput real.
  class MockAudioContext {
    constructor({ sampleRate }) { this.sampleRate = sampleRate; this.destination = {}; this.closed = false; contexts.push(this); }
    resume() { return Promise.resolve(); }
    close() { this.closed = true; return Promise.resolve(); }
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
    createAnalyser() { return { context: this, fftSize: 2048, frequencyBinCount: 1024, getByteFrequencyData: data => data.fill(0), connect() {}, disconnect() {} }; }
    createScriptProcessor() { this.processor = { onaudioprocess: null, connect() {}, disconnect() {} }; return this.processor; }
  }
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia: () => microphoneRequests.shift()?.promise ?? Promise.resolve(makeStream()) } });
  window.AudioContext = MockAudioContext;
  window.agentAPI.transcribeVoice = request => {
    const ack = deferred(); voiceCalls.push({ request, ack }); return ack.promise;
  };
  window.agentAPI.cancelVoiceTranscription = requestId => cancellations.push(requestId);
  const show = async projectId => {
    renderComposer({ project: { projectId, displayName: projectId ?? "I", canonicalPath: null }, modelOptions: props.modelOptions });
    await tick();
  };
  const startRecording = async () => {
    document.querySelector('[aria-label="Start voice input"]').click();
    await until(() => document.querySelector('[aria-label="Stop voice input"]'), "voice recording");
    const context = contexts.at(-1);
    context.processor.onaudioprocess({ inputBuffer: { getChannelData: () => new Float32Array([0.1, -0.1, 0.2, -0.2]) } });
    return context;
  };
  const transcribe = async () => {
    await startRecording();
    document.querySelector('[aria-label="Stop voice input"]').click();
    await tick();
    const call = voiceCalls.at(-1);
    check(call.request.audio instanceof ArrayBuffer && call.request.audio.byteLength > 44, "voice regression sends a nonempty encoded WAV through the real transcription path");
    return call;
  };
  try {
    await show("voice-a"); typeText("Voice A typed"); await tick();
    const lateA = await transcribe();
    await show("voice-b"); typeText("Voice B typed"); await tick();
    check(cancellations.includes(lateA.request.requestId), "switching project cancels the source transcription request");
    lateA.ack.resolve({ ok: true, text: "stale transcript A" }); await tick();
    check(document.querySelector("textarea").value === "Voice B typed", "a late A transcript cannot write into B");
    await show("voice-a");
    check(document.querySelector("textarea").value === "Voice A typed", "a cancelled transcript also leaves its source draft unchanged");
    const oldA = await transcribe();
    await show("voice-b"); await show("voice-a");
    const currentA = await transcribe();
    typeText("Current manual text"); await tick();
    oldA.ack.resolve({ ok: true, text: "stale A-B-A transcript" }); await tick();
    check(document.querySelector("textarea").value === "Current manual text" && document.querySelector('[aria-label="Cancel voice input"]'), "A-B-A rejects the old transcript and keeps the newer transcription pending");
    currentA.ack.resolve({ ok: true, text: "fresh transcript" }); await tick();
    check(document.querySelector("textarea").value === "Current manual text\nfresh transcript", "a current transcription appends to the latest manually edited text");
    const activeRecording = await startRecording();
    const recordingStream = streams.at(-1);
    const callsBeforeCancel = voiceCalls.length;
    await show(null);
    check(recordingStream.track.stopped && activeRecording.closed && !activeRecording.processor.onaudioprocess && voiceCalls.length === callsBeforeCancel, "scope changes stop recording resources without submitting captured audio");
    const permission = deferred(); microphoneRequests.push(permission);
    await show("voice-a");
    document.querySelector('[aria-label="Start voice input"]').click(); await tick();
    await show("voice-b"); await show("voice-a");
    const lateStream = makeStream(); const contextCount = contexts.length;
    permission.resolve(lateStream); await tick();
    check(lateStream.track.stopped && contexts.length === contextCount && document.querySelector('[aria-label="Start voice input"]'), "late microphone permission after A-B-A releases its stream and stays idle");
  } finally {
    // Finish in an idle scope before restoring the process-wide browser APIs.
    await show(null);
    window.AudioContext = originalAudioContext;
    if (originalMedia) Object.defineProperty(navigator, "mediaDevices", originalMedia);
    else delete navigator.mediaDevices;
    window.agentAPI.transcribeVoice = originalTranscribe;
    window.agentAPI.cancelVoiceTranscription = originalCancel;
  }
}
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

  await verifyComposerDrafts(renderComposer, props);
  await verifyVoiceDrafts(renderComposer, props);

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

test("Electron verifies project drafts, deferred ACKs, voice scope guards, uploads and modal focus", { timeout: 40_000 }, async (context) => {
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
    assert.ok(checks.length >= 70, checks.join("\n"));
    context.diagnostic(`${checks.length} browser assertions passed`);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
