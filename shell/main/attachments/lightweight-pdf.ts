import { createRequire } from "node:module";
import { dirname, join, sep } from "node:path";
import { createCanvas, type Canvas, type CanvasRenderingContext2D } from "@napi-rs/canvas";
import type { DocumentExtraction, DocumentSink } from "./lightweight-documents.js";

/** The same local Node canvas pipeline used by PDF.js examples/node/pdf2png. */
export async function extractPdf(
  bytes: Uint8Array,
  sink: DocumentSink,
  signal?: AbortSignal,
): Promise<DocumentExtraction> {
  // Preload native implementations before evaluating the PDF.js legacy module.
  const native = await import("@napi-rs/canvas");
  const globals = globalThis as unknown as Record<string, unknown>;
  for (const key of ["DOMMatrix", "ImageData", "Path2D"] as const) globals[key] ??= native[key];
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  sink.checkAbort();
  const root = dirname(createRequire(import.meta.url).resolve("pdfjs-dist/package.json"));
  const task = pdfjs.getDocument({
    data: bytes,
    // Node's built-in factories read these fixed package directories with fs.
    cMapUrl: join(root, "cmaps") + sep,
    cMapPacked: true,
    standardFontDataUrl: join(root, "standard_fonts") + sep,
    wasmUrl: join(root, "wasm") + sep,
    useWorkerFetch: false,
    enableXfa: false,
    useSystemFonts: false,
    disableFontFace: true,
    isOffscreenCanvasSupported: false,
    isImageDecoderSupported: false,
    maxImageSize: 16_000_000,
    canvasMaxAreaInBytes: 1600 * 1600 * 4,
    stopAtErrors: true,
    verbosity: 0,
  });
  const abort = () => { void task.destroy().catch(() => undefined); };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    sink.checkAbort();
    const document = await task.promise;
    const result: DocumentExtraction = {
      format: "pdf", unitKind: "page", totalUnits: document.numPages,
      units: [], images: [], truncationReasons: [],
      notes: [
        "PDF text uses embedded text in source page order. OCR is not performed.",
        "Pages with empty embedded text can be inspected through the available page images by a vision-capable model.",
        "Image previews cover at most the first two source pages; embedded images above 16 million pixels are omitted.",
      ],
    };
    if (document.numPages > 50) result.truncationReasons.push("unit-budget");
    for (let number = 1; number <= Math.min(document.numPages, 50); number++) {
      sink.checkAbort();
      if (!sink.remaining && number > 2) break;
      const page = await document.getPage(number);
      try {
        if (number <= 2) {
          const bounds = page.getViewport({ scale: 1 });
          if (![bounds.width, bounds.height].every((value) => Number.isFinite(value) && value > 0)) {
            throw new Error(`PDF page ${number} has invalid dimensions.`);
          }
          const viewport = page.getViewport({ scale: Math.min(1.5, 1600 / Math.max(bounds.width, bounds.height)) });
          const surface = createCanvas(Math.max(1, Math.floor(viewport.width)), Math.max(1, Math.floor(viewport.height)));
          await page.render({
            canvas: surface as never,
            canvasContext: surface.getContext("2d") as never,
            viewport,
            annotationMode: pdfjs.AnnotationMode.DISABLE,
            background: "rgb(255,255,255)",
          }).promise;
          sink.checkAbort();
          result.images.push({
            fileName: `page-${number}.jpg`, mediaType: "image/jpeg", label: `PDF page ${number}`,
            data: (surface as Canvas).toBuffer("image/jpeg", 85),
          });
        }
        if (!sink.remaining) continue;
        const unit = { index: number, source: `PDF page ${number}`, extractedCharacters: 0, empty: true, partial: false };
        result.units.push(unit);
        unit.partial = !sink.append(`\n## PDF page ${number}\n\n`);
        const reader = page.streamTextContent().getReader();
        try {
          while (!unit.partial) {
            sink.checkAbort();
            const { value, done } = await reader.read();
            if (done) break;
            for (const item of value.items) {
              if (!("str" in item)) continue;
              const content = item.str + (item.hasEOL ? "\n" : " ");
              if (item.str.trim()) unit.empty = false;
              const before = sink.remaining;
              unit.partial = !sink.append(content);
              unit.extractedCharacters += before - sink.remaining;
              if (unit.partial) break;
            }
          }
        } finally {
          await reader.cancel();
          reader.releaseLock();
        }
        if (unit.empty && !unit.partial) sink.append("[Empty embedded text on this source page.]\n");
        if (unit.partial) result.truncationReasons.push("text-budget");
      } finally {
        page.cleanup();
      }
    }
    if (result.units.length < Math.min(50, document.numPages) && !result.truncationReasons.includes("text-budget")) {
      result.truncationReasons.push("text-budget");
    }
    return result;
  } catch (error) {
    sink.checkAbort();
    throw error;
  } finally {
    signal?.removeEventListener("abort", abort);
    await task.destroy();
  }
}
