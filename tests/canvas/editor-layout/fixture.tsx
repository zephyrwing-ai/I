import { createRoot } from "react-dom/client";
import "../../../frontend/src/styles.css";
import {
  CanvasEditor,
  convertToCanvasEditorElements,
  exportToBlob,
  exportToSvg,
  serializeAsJSON,
} from "../../../canvas/engine/editor";
import { isValidCanvasEditorData } from "../../../canvas/engine/editor/data/json";
import { decodePngMetadata, getTEXtChunk } from "../../../canvas/engine/editor/data/image";
import { decodeSvgBase64Payload } from "../../../canvas/engine/editor/scene/export";
import { createPasteEvent, parseClipboard, serializeAsClipboardJSON } from "../../../canvas/engine/editor/clipboard";
import type { CanvasEditorImperativeAPI } from "../../../canvas/engine/editor/types";
import "../../../canvas/ui/CanvasSurface.css";

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
  root.unmount();
  return { samples, initialZoom, initialScroll, codecs };
}

Object.assign(window, { runCanvasLayoutRegression });
