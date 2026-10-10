import { createRoot } from "react-dom/client";
import "../../../frontend/src/styles.css";
import {
  CanvasEditor,
  convertToCanvasEditorElements,
  exportToBlob,
  exportToCanvas,
  exportToSvg,
  restoreElements,
  serializeAsJSON,
} from "../../../canvas/engine/editor";
import { isValidCanvasEditorData } from "../../../canvas/engine/editor/data/json";
import { decodePngMetadata, getTEXtChunk } from "../../../canvas/engine/editor/data/image";
import { decodeSvgBase64Payload } from "../../../canvas/engine/editor/scene/export";
import { createPasteEvent, parseClipboard, serializeAsClipboardJSON } from "../../../canvas/engine/editor/clipboard";
import type { CanvasEditorImperativeAPI } from "../../../canvas/engine/editor/types";
import { newElement, newFreeDrawElement, newLinearElement, newArrowElement, newTextElement, newImageElement } from "../../../canvas/engine/editor/element/newElement";
import { getElementShape } from "../../../canvas/engine/editor/shapes";
import { hitElementItself } from "../../../canvas/engine/editor/element/collision";
import { ShapeCache } from "../../../canvas/engine/editor/scene/ShapeCache";
import { FONT_FAMILY } from "../../../canvas/engine/editor/constants";
import { Fonts } from "../../../canvas/engine/editor/fonts";
import { getLanguage, setLanguage, t } from "../../../canvas/engine/editor/i18n";
import { sceneCoordsToViewportCoords } from "../../../canvas/engine/editor/utils";
import "../../../canvas/ui/CanvasSurface.css";
import { checkCanvasSurfacePersistence } from "./save-surface";

const root = createRoot(document.getElementById("root")!);
let editor: CanvasEditorImperativeAPI | undefined;
const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
const frames = async () => { await frame(); await frame(); };

async function until(condition: () => boolean, description: string) {
  for (let attempt = 0; attempt < 180; attempt += 1) {
    if (condition()) return;
    await frame();
  }
  throw new Error(`Canvas fixture did not reach: ${description}`);
}

const bounds = (element: Element) => {
  const { x, y, width, height, right, bottom } = element.getBoundingClientRect();
  return { x, y, width, height, right, bottom };
};

const navigationState = () => {
  const appState = editor!.getAppState();
  const canvas = document.querySelector<HTMLCanvasElement>("canvas.interactive")!;
  return {
    tool: appState.activeTool.type,
    locked: appState.activeTool.locked,
    checkedTools: [...document.querySelectorAll<HTMLInputElement>('.App-toolbar--canvas input[type="radio"][data-testid]:checked')]
      .map((input) => input.dataset.testid!.replace("toolbar-", "")),
    cursor: getComputedStyle(canvas).cursor,
    selectedIds: Object.keys(appState.selectedElementIds).sort(),
    scroll: [appState.scrollX, appState.scrollY],
  };
};

async function checkHandSelection(coldStart: ReturnType<typeof navigationState>) {
  const canvas = document.querySelector<HTMLCanvasElement>("canvas.interactive")!;
  const container = document.querySelector<HTMLElement>(".agent-canvas-container")!;
  const elements = convertToCanvasEditorElements([
    { type: "rectangle", id: "navigation-rectangle", x: 180, y: 140, width: 160, height: 100 },
  ], { regenerateIds: false });
  const replace = async () => {
    editor!.replaceScene({
      elements: structuredClone(elements),
      appState: { zoom: { value: 1 as never }, scrollX: 0, scrollY: 0 },
      files: {},
    });
    container.focus();
    await frames();
  };
  const key = async (type: "keydown" | "keyup", key: string, metaKey = false, target: Element = canvas, code?: string) => {
    target.dispatchEvent(new KeyboardEvent(type, { bubbles: true, cancelable: true, key, code, metaKey }));
    await frames();
  };
  const point = (sceneX: number, sceneY: number) => sceneCoordsToViewportCoords({ sceneX, sceneY }, editor!.getAppState());
  const pointer = async (type: "pointerdown" | "pointermove" | "pointerup", point: { x: number; y: number }, metaKey = false) => {
    canvas.dispatchEvent(new PointerEvent(type, {
      bubbles: true, cancelable: true, pointerId: 1, pointerType: "mouse", button: 0,
      buttons: type === "pointerup" ? 0 : 1, clientX: point.x, clientY: point.y, metaKey,
    }));
    await frames();
  };
  const drag = async (start: { x: number; y: number }, delta: { x: number; y: number }, metaKey = false) => {
    await pointer("pointerdown", start, metaKey);
    const end = { x: start.x + delta.x, y: start.y + delta.y };
    await pointer("pointermove", end, metaKey);
    await pointer("pointerup", end, metaKey);
  };
  const position = () => {
    const element = editor!.getSceneElements().find((element) => element.id === "navigation-rectangle")!;
    return [element.x, element.y];
  };

  await replace();
  const sceneReplacement = navigationState();
  const originalScene = JSON.stringify(editor!.getSceneElements());
  const panStart = point(700, 400);
  await drag(panStart, { x: 50, y: 30 });
  const handPan = { ...navigationState(), unchanged: JSON.stringify(editor!.getSceneElements()) === originalScene };

  await replace();
  await key("keydown", "Meta", true);
  const commandPressed = navigationState();
  const edge = point(250, 140);
  await pointer("pointerdown", edge, true);
  await pointer("pointerup", edge, true);
  const commandSelected = navigationState();
  await drag(point(250, 140), { x: 40, y: 30 }, true);
  const commandMoved = { ...navigationState(), position: position() };
  await key("keyup", "Meta");
  const commandReleased = navigationState();

  // Native Cmd+C delivers a copy event after the key event. Capture transport only;
  // the real action and serialization run without touching the user's clipboard.
  const clipboard = navigator.clipboard;
  const writeTextDescriptor = Object.getOwnPropertyDescriptor(clipboard, "writeText");
  let copiedText = "";
  Object.defineProperty(clipboard, "writeText", { configurable: true, value: async (text: string) => { copiedText = text; } });
  let copyIds: string[] = [];
  try {
    await key("keydown", "Meta", true);
    await key("keydown", "c", true, canvas, "KeyC");
    canvas.dispatchEvent(new ClipboardEvent("copy", { bubbles: true, cancelable: true, clipboardData: new DataTransfer() }));
    await until(() => copiedText.length > 0, "Cmd+C scene serialization");
    copyIds = JSON.parse(copiedText).elements.map((element: { id: string }) => element.id);
    await key("keyup", "c", true, canvas, "KeyC");
    await key("keydown", "z", true, canvas, "KeyZ");
    await key("keyup", "z", true, canvas, "KeyZ");
    await key("keyup", "Meta");
  } finally {
    if (writeTextDescriptor) Object.defineProperty(clipboard, "writeText", writeTextDescriptor);
    else Reflect.deleteProperty(clipboard, "writeText");
  }
  const shortcuts = { copyIds, positionAfterUndo: position(), toolAfterUndo: editor!.getAppState().activeTool.type };

  await replace();
  const deferredStart = point(700, 400);
  await pointer("pointerdown", deferredStart);
  await key("keydown", "Meta", true);
  const commandDuringPan = navigationState();
  const deferredEnd = { x: deferredStart.x + 25, y: deferredStart.y + 15 };
  await pointer("pointermove", deferredEnd, true);
  await pointer("pointerup", deferredEnd, true);
  const commandAfterPan = navigationState();
  await key("keyup", "Meta");
  const afterDeferredPan = navigationState();

  await replace();
  editor!.setActiveTool({ type: "selection" });
  await frames();
  await key("keydown", "Meta", true);
  await drag(point(250, 140), { x: 40, y: 30 }, true);
  const explicitSelectionMoved = { ...navigationState(), position: position() };
  await key("keyup", "Meta");
  const explicitSelectionAfterRelease = navigationState();

  await replace();
  await key("keydown", "Meta", true);
  const heldStart = point(250, 140);
  await pointer("pointerdown", heldStart, true);
  await key("keyup", "Meta");
  const releaseDuringDrag = navigationState();
  const heldEnd = { x: heldStart.x + 30, y: heldStart.y + 20 };
  await pointer("pointermove", heldEnd);
  await pointer("pointerup", heldEnd);
  const releaseAfterDrag = { ...navigationState(), position: position() };

  await replace();
  editor!.setActiveTool({ type: "rectangle" });
  await frames();
  await key("keydown", "Meta", true);
  const originalToolOverridden = navigationState();
  await key("keyup", "Meta", true);
  const secondCommandStillHeld = navigationState();
  await key("keyup", "Meta");
  const originalToolRestored = navigationState();
  const beforeSpace = JSON.stringify(editor!.getSceneElements());
  await key("keydown", " ");
  await drag(point(700, 400), { x: 20, y: 10 });
  await key("keyup", " ");
  const spacePan = { ...navigationState(), unchanged: JSON.stringify(editor!.getSceneElements()) === beforeSpace };

  await replace();
  const outsideButton = document.createElement("button");
  document.body.append(outsideButton);
  outsideButton.focus();
  await key("keydown", "Meta", true, outsideButton);
  const commandOutsideCanvas = navigationState();
  outsideButton.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1, pointerType: "mouse", button: 0, buttons: 0, metaKey: true }));
  await frames();
  const commandOutsidePointerUp = navigationState();
  const entry = point(700, 400);
  canvas.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerId: 1, pointerType: "mouse", buttons: 0, clientX: entry.x, clientY: entry.y, metaKey: true }));
  await frames();
  const commandHeldOnEntry = navigationState();
  await key("keyup", "Meta");
  await replace();
  outsideButton.focus();
  await key("keydown", "Meta", true, outsideButton);
  const entryEdge = point(250, 140);
  await pointer("pointerdown", entryEdge, true);
  await pointer("pointerup", entryEdge, true);
  const commandHeldOnPointerDown = navigationState();
  await key("keyup", "Meta");
  outsideButton.remove();

  await replace();
  await key("keydown", "Meta", true);
  editor!.setActiveTool({ type: "ellipse" });
  await frames();
  const explicitToolSwitch = navigationState();
  const explicitPoint = point(700, 400);
  canvas.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerId: 1, pointerType: "mouse", buttons: 0, clientX: explicitPoint.x, clientY: explicitPoint.y, metaKey: true }));
  await frames();
  const heldPointerAfterExplicitSwitch = navigationState();
  await key("keyup", "Meta");
  const explicitToolAfterRelease = navigationState();
  await replace();
  editor!.setActiveTool({ type: "rectangle" });
  await frames();
  await key("keydown", "Meta", true);
  document.querySelector<HTMLInputElement>('[data-testid="toolbar-hand"]')!.click();
  await frames();
  const explicitHandClick = navigationState();
  await key("keyup", "Meta");
  const explicitHandAfterRelease = navigationState();
  await replace();
  editor!.setActiveTool({ type: "rectangle" });
  await frames();
  await key("keydown", "Meta", true);
  const beforeLockClick = navigationState();
  document.querySelector<HTMLInputElement>('[data-testid="toolbar-lock"]')!.click();
  await frames();
  const explicitLockClick = navigationState();
  await key("keyup", "Meta");
  const explicitLockAfterRelease = navigationState();
  await replace();
  const ignoredInputs = [];
  for (const tagName of ["input", "textarea"]) {
    const input = document.createElement(tagName);
    container.append(input);
    input.focus();
    await key("keydown", "Meta", true, input);
    ignoredInputs.push({ tagName, ...navigationState() });
    await key("keyup", "Meta", false, input);
    input.remove();
  }
  container.focus();
  await key("keydown", "Meta", true);
  window.dispatchEvent(new Event("blur"));
  await frames();
  const afterBlur = navigationState();
  container.focus();
  await key("keydown", "Meta", true);
  await replace();
  const afterHeldSceneReplacement = navigationState();
  await key("keyup", "Meta");

  return {
    coldStart, sceneReplacement, handPan, commandPressed, commandSelected, commandMoved, commandReleased,
    shortcuts, commandDuringPan, commandAfterPan, afterDeferredPan, explicitSelectionMoved, explicitSelectionAfterRelease,
    releaseDuringDrag, releaseAfterDrag,
    originalToolOverridden, secondCommandStillHeld, originalToolRestored, spacePan, commandOutsideCanvas, commandOutsidePointerUp, commandHeldOnEntry, commandHeldOnPointerDown,
    explicitToolSwitch, heldPointerAfterExplicitSwitch, explicitToolAfterRelease,
    explicitHandClick, explicitHandAfterRelease, beforeLockClick, explicitLockClick, explicitLockAfterRelease,
    ignoredInputs, afterBlur, afterHeldSceneReplacement,
  };
}

async function checkOutlineRendering(appState: ReturnType<CanvasEditorImperativeAPI["getAppState"]>) {
  const box = { x: 0, y: 0, width: 120, height: 100 };
  const loop = [[0, 0], [120, 0], [120, 100], [0, 100], [0, 0]] as never;
  const imageCanvas = document.createElement("canvas");
  imageCanvas.width = imageCanvas.height = 12;
  const imageContext = imageCanvas.getContext("2d")!;
  imageContext.fillStyle = "#00aa00";
  imageContext.fillRect(0, 0, 12, 12);
  const files = {
    "outline-image": { id: "outline-image" as never, mimeType: "image/png", dataURL: imageCanvas.toDataURL() as never, created: 1 },
  };
  const examples = [
    newElement({ ...box, type: "rectangle" }),
    newElement({ ...box, type: "diamond" }),
    newElement({ ...box, type: "ellipse", angle: (Math.PI / 6) as never }),
    newLinearElement({ ...box, type: "line", points: loop }),
    newFreeDrawElement({ ...box, type: "freedraw", points: loop, simulatePressure: true }),
    newArrowElement({ ...box, type: "arrow", points: [[0, 0], [120, 100]] as never, endArrowhead: "arrow" }),
    newTextElement({ x: 0, y: 0, text: "Canvas text" }),
    newImageElement({ ...box, type: "image", fileId: "outline-image" as never, status: "saved" }),
  ];
  const samples = [];
  for (const example of examples) {
    const [element] = restoreElements([{
      ...example,
      backgroundColor: "#ff0000",
      fillStyle: "cross-hatch",
      ...(example.type === "arrow" ? { endArrowhead: "triangle" } : {}),
    } as never], null);
    const canvas = await exportToCanvas({ elements: [element], appState: { ...appState, exportBackground: false, exportScale: 1 }, files, exportPadding: 0 });
    const context = canvas.getContext("2d")!;
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let paintedPixels = 0;
    for (let index = 3; index < pixels.length; index += 4) if (pixels[index] > 0) paintedPixels += 1;
    const center = [...context.getImageData(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1).data];
    const svg = await exportToSvg({ elements: [element], appState: { ...appState, exportBackground: false }, files });
    const shape = ShapeCache.generateElementShape(element, null);
    const drawables = Array.isArray(shape) ? shape : shape ? [shape] : [];
    const map = new Map([[element.id, element]]);
    const interiorHit = ["rectangle", "diamond", "ellipse", "line", "freedraw"].includes(element.type)
      ? hitElementItself({ x: element.x + element.width / 2, y: element.y + element.height / 2, element, shape: getElementShape(element, map), threshold: 2 })
      : null;
    samples.push({
      type: element.type,
      hasLegacyFill: Object.hasOwn(element, "fillStyle") || Object.hasOwn(element, "backgroundColor"),
      paintedPixels,
      center,
      fillSets: drawables.flatMap((drawable) => drawable.sets).filter((set) => set.type !== "path").length,
      redSvgFill: Boolean(svg.querySelector('[fill="#ff0000"]')),
      interiorHit,
      arrowhead: element.type === "arrow" ? element.endArrowhead : null,
      arrowShapes: element.type === "arrow" ? drawables.length : null,
    });
  }
  return samples;
}

async function checkTextFonts(appState: ReturnType<CanvasEditorImperativeAPI["getAppState"]>) {
  const text = "Canvas 画布 😀 👩‍💻";
  const samples = [];
  const families = [
    FONT_FAMILY.Virgil,
    FONT_FAMILY.Helvetica,
    FONT_FAMILY.Cascadia,
    FONT_FAMILY.Excalifont,
    FONT_FAMILY.Nunito,
    FONT_FAMILY["Lilita One"],
    FONT_FAMILY["Comic Shanns"],
    FONT_FAMILY["Liberation Sans"],
  ];
  for (const fontFamily of families) {
    const [element] = restoreElements([newTextElement({ x: 0, y: 0, text, fontSize: 24, fontFamily })], null);
    if (element.type !== "text") throw new Error("Font fixture requires a text element");
    await Fonts.loadElementsFonts([element]);
    const exportedState = { ...appState, exportBackground: false, exportEmbedScene: true, exportScale: 1 };
    const png = await exportToBlob({ elements: [element], appState: exportedState, files: {} });
    const bitmap = await createImageBitmap(png);
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d")!;
    context.drawImage(bitmap, 0, 0);
    bitmap.close();
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let paintedPixels = 0;
    for (let index = 3; index < pixels.length; index += 4) if (pixels[index] > 0) paintedPixels += 1;
    const pngElement = JSON.parse(await decodePngMetadata(png)).elements[0];
    const svg = await exportToSvg({ elements: [element], appState: exportedState, files: {} });
    const embeddedFonts = svg.querySelector(".style-fonts")?.textContent ?? "";
    samples.push({
      fontFamily,
      restoredFamily: element.fontFamily,
      pngType: png.type,
      paintedPixels,
      pngText: pngElement.originalText,
      pngFamily: pngElement.fontFamily,
      svgText: [...svg.querySelectorAll("text")].map((node) => node.textContent).join("\n"),
      svgFontFamily: svg.querySelector("text")?.getAttribute("font-family"),
      embeddedFamilies: [...embeddedFonts.matchAll(/font-family:\s*([^;]+);/g)].map((match) => match[1].trim().replace(/^['"]|['"]$/g, "")),
      embeddedFontData: embeddedFonts.includes("data:font/woff2;base64,"),
    });
  }
  return samples;
}

async function checkTextInput() {
  const text = "中文输入 😀 👩‍💻";
  editor!.setActiveTool({ type: "text" });
  await frames();
  const canvas = document.querySelector<HTMLCanvasElement>("canvas.interactive")!;
  const { x, y } = bounds(canvas);
  const pointer = { bubbles: true, clientX: x + 700, clientY: y + 430, pointerId: 1, pointerType: "mouse", button: 0 };
  canvas.dispatchEvent(new PointerEvent("pointerdown", { ...pointer, buttons: 1 }));
  await frames();
  canvas.dispatchEvent(new PointerEvent("pointerup", { ...pointer, buttons: 0 }));
  await until(() => !!document.querySelector('textarea[data-type="wysiwyg"]'), "text editor input").catch((error) => {
    const state = editor!.getAppState();
    throw new Error(`${error.message}; tool=${JSON.stringify(state.activeTool)}; editing=${JSON.stringify(state.editingTextElement)}; loading=${state.isLoading}; canvas=${JSON.stringify(bounds(canvas))}; input=${document.querySelector("textarea")?.outerHTML}; count=${editor!.getSceneElements().length}`);
  });
  const input = document.querySelector<HTMLTextAreaElement>('textarea[data-type="wysiwyg"]')!;
  input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
  input.value = text;
  input.dispatchEvent(new InputEvent("input", { bubbles: true, data: text, inputType: "insertCompositionText", isComposing: true }));
  input.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: text }));
  input.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape" }));
  await until(() => !document.querySelector('textarea[data-type="wysiwyg"]'), "text input commit");
  const element = editor!.getSceneElements().find((element) => element.type === "text" && element.originalText === text);
  return { text: element?.type === "text" ? element.originalText : null, fontFamily: element?.type === "text" ? element.fontFamily : null };
}

async function checkLanguageFallback() {
  const samples = [];
  for (const language of [{ code: "zh-CN", label: "Chinese" }, { code: "ar-SA", label: "Arabic", rtl: true }]) {
    await setLanguage(language);
    samples.push({ requested: language.code, current: getLanguage().code, documentLanguage: document.documentElement.lang, direction: document.documentElement.dir, label: t("labels.moveCanvas") });
  }
  return samples;
}

async function checkProductCapabilities(appState: ReturnType<CanvasEditorImperativeAPI["getAppState"]>) {
  editor!.setActiveTool({ type: "selection" });
  await frames();
  const canvas = document.querySelector<HTMLCanvasElement>("canvas.interactive")!;
  canvas.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "f" }));
  await frames();
  const toolAfterFrameShortcut = editor!.getAppState().activeTool.type;
  editor!.setActiveTool({ type: "frame" });
  await frames();
  const toolAfterUnsupportedAPI = editor!.getAppState().activeTool.type;
  const legacy = [];
  for (const type of ["iframe", "embeddable", "magicframe"]) {
    const template = newElement({ type: "rectangle", x: 0, y: 0, width: 180, height: 120 });
    const [element] = restoreElements([{
      ...template, type, name: "Legacy frame", link: "https://example.com/legacy",
      customData: { generationData: { status: "done", html: "<script>window.legacyExecuted = true</script>" } },
    } as never], null);
    const bitmap = await exportToCanvas({ elements: [element], appState, files: {}, exportPadding: 0 });
    const pixels = bitmap.getContext("2d")!.getImageData(0, 0, bitmap.width, bitmap.height).data;
    const svg = await exportToSvg({ elements: [element], appState: { ...appState, exportEmbedScene: false }, files: {} });
    legacy.push({ type, visible: pixels.some((value, index) => index % 4 === 3 && value > 0), activeDOM: !!svg.querySelector("iframe, foreignObject, script") });
  }
  return { toolAfterFrameShortcut, toolAfterUnsupportedAPI, libraryAPI: "updateLibrary" in editor!, generationAPI: "setPlugins" in editor!, legacy };
}

async function runCanvasLayoutRegression() {
  const elements = convertToCanvasEditorElements([
    { type: "rectangle", id: "layout-rectangle", x: 180, y: 140, width: 160, height: 100 },
  ]);
  root.render(
    <div id="sidebar-fixture" style={{ width: 1200, height: 760 }}>
      <section className="canvas-panel">
        <div className="canvas-panel-editor">
          <CanvasEditor
            canvasAPI={(api) => { editor = api; }}
            initialData={{ elements, appState: { viewBackgroundColor: "#f7f3ee", zoom: { value: 0.75 as never }, scrollX: 32, scrollY: 18 } }}
            langCode="en"
          />
        </div>
      </section>
    </div>,
  );
  await until(() => !!editor && !editor.getAppState().isLoading && !!document.querySelector(".App-toolbar--canvas"), "editor initialization");
  await frames();
  const coldStartNavigation = navigationState();

  const sidebar = document.getElementById("sidebar-fixture")!;
  const toolbar = document.querySelector<HTMLElement>(".App-toolbar--canvas")!;
  const footer = document.querySelector<HTMLElement>(".App-menu_bottom")!;
  const visibleButtons = () => [...toolbar.querySelectorAll<HTMLElement>(".ToolIcon")]
    .filter((button) => button.getBoundingClientRect().width > 0);
  const buttons = visibleButtons();
  const initialScene = JSON.stringify(editor!.getSceneElements());
  const initialZoom = editor!.getAppState().zoom.value;
  const initialScroll = [editor!.getAppState().scrollX, editor!.getAppState().scrollY];
  const samples = [];
  for (const width of [1200, 800, 729, 500, 320, 1200]) {
    sidebar.style.width = `${width}px`;
    await until(() => editor!.getAppState().width === width, `viewport width ${width}`);
    await frames();
    const currentButtons = visibleButtons();
    samples.push({
      width,
      viewportWidth: editor!.getAppState().width,
      sameToolbar: document.querySelector(".App-toolbar--canvas") === toolbar,
      sameFooter: document.querySelector(".App-menu_bottom") === footer,
      sameButtons: currentButtons.length === buttons.length && currentButtons.every((button, index) => button === buttons[index]),
      toolbar: bounds(toolbar),
      footer: bounds(footer),
      sidebar: bounds(sidebar),
      buttons: currentButtons.map((button) => ({
        label: button.getAttribute("aria-label") ?? button.querySelector("input")?.getAttribute("aria-label"),
        ...bounds(button),
      })),
      mobileContainers: document.querySelectorAll(".App-bottom-bar, .App-toolbar--mobile, .mobile-misc-tools-container").length,
      pageScrollWidth: document.documentElement.scrollWidth,
      pageWidth: document.documentElement.clientWidth,
      pageScrollHeight: document.documentElement.scrollHeight,
      pageHeight: document.documentElement.clientHeight,
      sceneUnchanged: JSON.stringify(editor!.getSceneElements()) === initialScene,
      zoom: editor!.getAppState().zoom.value,
      scroll: [editor!.getAppState().scrollX, editor!.getAppState().scrollY],
      buttonSizeToken: getComputedStyle(document.querySelector(".agent-canvas")!).getPropertyValue("--default-button-size").trim(),
    });
  }

  // These are real browser codecs and exporters, not mocks or OS clipboard writes.
  // Keeping legacy wire values catches invalid member access introduced by renaming.
  const sceneElements = editor!.getSceneElements();
  const appState = editor!.getAppState();
  const json = serializeAsJSON(sceneElements, appState, {}, "local");
  const scene = JSON.parse(json);
  const clipboard = serializeAsClipboardJSON({ elements: sceneElements, files: {} });
  const pasted = await parseClipboard(createPasteEvent({ types: { "text/plain": clipboard } }));
  const exportedState = { ...appState, exportEmbedScene: true, exportBackground: true };
  const png = await exportToBlob({ elements: sceneElements, appState: exportedState, files: {} });
  const pngScene = JSON.parse(await decodePngMetadata(png));
  const svg = await exportToSvg({ elements: sceneElements, appState: exportedState, files: {} });
  const svgScene = JSON.parse(decodeSvgBase64Payload({ svg: svg.outerHTML }));
  const codecs = {
    json: { valid: isValidCanvasEditorData(scene), type: scene.type, version: scene.version, id: scene.elements[0].id },
    clipboard: { type: JSON.parse(clipboard).type, ids: pasted.elements?.map((element) => element.id) },
    png: { type: png.type, keyword: (await getTEXtChunk(png))?.keyword, sceneType: pngScene.type, ids: pngScene.elements.map((element: { id: string }) => element.id) },
    svg: { sceneType: svgScene.type, ids: svgScene.elements.map((element: { id: string }) => element.id) },
  };
  const outlineRendering = await checkOutlineRendering(appState);
  const documentVersion = editor!.getDocumentVersion();
  window.dispatchEvent(new Event("focus"));
  await frames();
  const versionAfterFocus = editor!.getDocumentVersion();
  const editResult = editor!.applyCanvasEdit([
    { action: "create", element: { type: "rectangle", x: 420, y: 140, width: 120, height: 80 } },
  ], []);
  await frames();
  const versionAfterEdit = editor!.getDocumentVersion();
  const assetCanvas = document.createElement("canvas");
  assetCanvas.width = assetCanvas.height = 1;
  editor!.addFiles([{ id: "constructor" as never, mimeType: "image/png", dataURL: assetCanvas.toDataURL() as never, created: 1 }]);
  await frames();
  const documentChanges = {
    documentVersion,
    versionAfterFocus,
    versionAfterEdit,
    versionAfterResourceAdd: editor!.getDocumentVersion(),
    editSucceeded: editResult.ok,
    createdIds: editResult.createdIds,
    previousElementPreserved: editor!.getSceneElements().some((element) => element.id === sceneElements[0].id),
    elementCount: editor!.getSceneElements().length,
    resourceOwnKey: Object.hasOwn(editor!.getFiles(), "constructor"),
  };
  const textInput = await checkTextInput();
  const handSelection = await checkHandSelection(coldStartNavigation);
  const capabilities = await checkProductCapabilities(appState);
  const textFonts = await checkTextFonts(appState);
  const languageFallback = await checkLanguageFallback();
  document.querySelector<HTMLElement>(".agent-canvas-container")!.focus();
  document.querySelector("canvas.interactive")!.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Meta", metaKey: true }));
  await frames();
  root.unmount();
  window.dispatchEvent(new KeyboardEvent("keyup", { key: "Meta" }));
  const nextRoot = createRoot(document.getElementById("root")!);
  editor = undefined;
  nextRoot.render(<div style={{ width: 1200, height: 760 }}><CanvasEditor canvasAPI={(api) => { editor = api; }} initialData={{ elements: [] }} /></div>);
  await until(() => !!editor && !editor.getAppState().isLoading && !!document.querySelector(".App-toolbar--canvas"), "fresh editor after temporary selection unmount");
  await frames();
  const afterRemount = navigationState();
  nextRoot.unmount();
  const persistence = await checkCanvasSurfacePersistence();
  return { samples, initialZoom, initialScroll, codecs, outlineRendering, documentChanges, persistence, textInput, textFonts, languageFallback, capabilities, handSelection: { ...handSelection, afterRemount } };
}

Object.assign(window, { runCanvasLayoutRegression });
