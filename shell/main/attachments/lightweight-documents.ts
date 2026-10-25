import { open, mkdir, writeFile, unlink } from "node:fs/promises";
import { extname, join } from "node:path";
import type { AttachmentPreparation, AttachmentProcessorInput } from "./processors.js";
import { extractOffice } from "./lightweight-office.js";
import { extractPdf } from "./lightweight-pdf.js";

const FILE_BYTES = 64 * 1024 * 1024;
const TEXT_CHARACTERS = 200_000;
// Reserve room for provenance even when a source exhausts the text budget.
const CONTENT_CHARACTERS = TEXT_CHARACTERS - 6_000;
type DocumentFormat = "pdf" | "docx" | "pptx" | "xlsx";

export interface DocumentSink {
  readonly remaining: number;
  append(text: string): boolean;
  checkAbort(): void;
}

export interface SourceUnit {
  index: number;
  source: string;
  extractedCharacters: number;
  empty: boolean;
  partial: boolean;
}

export interface DocumentExtraction {
  format: DocumentFormat;
  unitKind: "page" | "document" | "slide" | "sheet";
  totalUnits: number;
  units: SourceUnit[];
  images: Array<AttachmentPreparation["images"][number] & { data: Uint8Array }>;
  notes: string[];
  truncationReasons: string[];
}

function formatOf(input: AttachmentProcessorInput): DocumentFormat {
  const explicit = input.documentFormat;
  const mediaFormats: Record<string, DocumentFormat> = {
    "application/pdf": "pdf",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  };
  const format = explicit?.toLowerCase().replace(/^\./, "")
    ?? mediaFormats[input.mediaType.split(";", 1)[0].toLowerCase()]
    ?? extname(input.name).slice(1).toLowerCase();
  if (!["pdf", "docx", "pptx", "xlsx"].includes(format)) {
    throw new Error("Choose a PDF, DOCX, PPTX or XLSX document.");
  }
  return format as DocumentFormat;
}

async function readDocument(path: string, checkAbort: () => void): Promise<Uint8Array> {
  const file = await open(path, "r");
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > FILE_BYTES) {
      throw new Error("Choose a regular document within the 64 MiB input budget.");
    }
    const bytes = new Uint8Array(info.size);
    let offset = 0;
    while (offset < bytes.length) {
      checkAbort();
      const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) throw new Error("The document changed while it was being read.");
      offset += bytesRead;
    }
    const extra = await file.read(new Uint8Array(1), 0, 1, offset);
    if (extra.bytesRead) throw new Error("The document changed while it was being read.");
    checkAbort();
    return bytes;
  } finally {
    await file.close();
  }
}

/** Local conversion only. The Main utility-process owner supplies the hard timeout. */
export async function prepareLightDocument(
  input: AttachmentProcessorInput,
  signal?: AbortSignal,
): Promise<AttachmentPreparation> {
  const checkAbort = () => {
    if (signal?.aborted) {
      throw Object.assign(new Error("Attachment preparation was cancelled."), { name: "AbortError" });
    }
  };
  checkAbort();
  const format = formatOf(input);
  const bytes = await readDocument(input.path, checkAbort);
  const chunks: string[] = [];
  let characters = 0;
  let textTruncated = false;
  const sink: DocumentSink = {
    get remaining() { return CONTENT_CHARACTERS - characters; },
    checkAbort,
    append(text) {
      checkAbort();
      let length = Math.min(text.length, CONTENT_CHARACTERS - characters);
      // A character boundary always retains both halves of a Unicode surrogate pair.
      if (length < text.length && /[\uD800-\uDBFF]/.test(text.charAt(length - 1))) length--;
      if (length) chunks.push(text.slice(0, length));
      characters += length;
      if (length < text.length) textTruncated = true;
      return length === text.length;
    },
  };
  const extraction = format === "pdf"
    ? await extractPdf(bytes, sink, signal)
    : extractOffice(bytes, format, sink);
  checkAbort();
  if (textTruncated && !extraction.truncationReasons.includes("text-budget")) {
    extraction.truncationReasons.push("text-budget");
  }
  const truncated = extraction.truncationReasons.length > 0;
  const renderedPages = extraction.images.map((image) => Number(image.fileName.match(/\d+/)?.[0]));
  const sourceCoverage = {
    format,
    method: format === "pdf" ? "pdfjs-embedded-text-and-page-images" : "native-ooxml",
    unitKind: extraction.unitKind,
    totalUnits: extraction.totalUnits,
    processedUnits: extraction.units.length,
    units: extraction.units,
    renderedPages,
    ocrPerformed: false,
    formulasComputed: false,
    empty: extraction.units.every((unit) => unit.empty),
    truncated,
    truncationReasons: extraction.truncationReasons,
    limits: { inputBytes: FILE_BYTES, textCharacters: TEXT_CHARACTERS, contentCharacters: CONTENT_CHARACTERS, units: 50, images: 2, imageLongEdge: 1600 },
    notes: extraction.notes,
  };
  const header = [
    `Coverage: ${format.toUpperCase()} ${extraction.unitKind} sources ${extraction.units.length ? `1–${extraction.units.length}` : "none"} of ${extraction.totalUnits}.`,
    `Text coverage: ${truncated ? `bounded prefix (${extraction.truncationReasons.join(", ")})` : "complete supported source structure"}.`,
    `Image coverage: ${renderedPages.length ? `PDF source pages ${renderedPages.join(", ")}` : "none"}.`,
    ...extraction.notes,
    ...(sourceCoverage.empty ? ["Empty text coverage: the selected source units contain no extractable text."] : []),
  ].join("\n");
  const text = `${header}\n\n${chunks.join("")}`;
  if (text.length > TEXT_CHARACTERS) throw new Error("Document provenance exceeded the text budget.");
  const images = extraction.images.map(({ data: _data, ...image }) => image);
  const result: AttachmentPreparation = { text, images, truncated };
  if (images.length) result.previewFile = images[0].fileName;

  await mkdir(input.outputDirectory, { recursive: true });
  const created: string[] = [];
  try {
    const files = [
      ...extraction.images.map((image) => ({ name: image.fileName, data: image.data })),
      { name: "document.md", data: text },
      { name: "document.json", data: JSON.stringify({ ...result, sourceCoverage }, null, 2) },
    ];
    for (const file of files) {
      checkAbort();
      const path = join(input.outputDirectory, file.name);
      // Exclusive creation preserves the utility-process owner's existing artifacts.
      const handle = await open(path, "wx");
      created.push(path);
      try { await handle.writeFile(file.data); } finally { await handle.close(); }
    }
    checkAbort();
    return result;
  } catch (error) {
    await Promise.allSettled(created.map((path) => unlink(path)));
    throw error;
  }
}
