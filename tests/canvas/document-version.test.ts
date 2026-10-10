import assert from "node:assert/strict";
import test from "node:test";
import { DocumentVersionTracker } from "../../canvas/engine/editor/scene/DocumentVersion.js";

type Elements = Parameters<DocumentVersionTracker["observe"]>[0];
type Files = Parameters<DocumentVersionTracker["observe"]>[1];

function element(id = "rectangle-1", version = 1) {
  return { id, version, versionNonce: version * 10, index: "a0", isDeleted: false };
}

test("document versions stay stable through copied scenes and drawing-cache refreshes", () => {
  const tracker = new DocumentVersionTracker();
  const elements = [element()] as Elements;
  const baseline = tracker.observe(elements, {});
  assert.equal(tracker.observe(elements, {}), baseline);
  assert.equal(tracker.observe(elements.map((item) => ({ ...item })), {}), baseline);
});

test("element mutations, deletion and layer order advance the document version", () => {
  const tracker = new DocumentVersionTracker();
  const first = element();
  const second = element("rectangle-2");
  const elements = [first, second] as Elements;
  const baseline = tracker.observe(elements, {});
  first.version += 1;
  assert.equal(tracker.observe(elements, {}), baseline + 1, "in-place mutations compare against frozen stamps");
  assert.equal(tracker.observe([elements[1], elements[0]], {}), baseline + 2);
  first.isDeleted = true;
  assert.equal(tracker.observe([elements[1], elements[0]], {}), baseline + 3);
  assert.equal(tracker.observe([elements[1]], {}), baseline + 4);
});

test("image-byte changes advance the version even when element versions stay equal", () => {
  const tracker = new DocumentVersionTracker();
  const files = {
    "image-1": { id: "image-1", mimeType: "image/png", dataURL: "data:image/png;base64,AA==", created: 1 },
  } as Files;
  const baseline = tracker.observe([], files);
  assert.equal(tracker.observe([], { ...files }), baseline);
  files["image-1"].dataURL = "data:image/png;base64,AQ==" as typeof files["image-1"]["dataURL"];
  assert.equal(tracker.observe([], files), baseline + 1);
  assert.equal(tracker.observe([], {}), baseline + 2);
});
