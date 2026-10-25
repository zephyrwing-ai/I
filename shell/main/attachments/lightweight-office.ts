import { XMLParser } from "fast-xml-parser";
import { unzipSync, type UnzipFileInfo } from "fflate";
import type { DocumentExtraction, DocumentSink } from "./lightweight-documents.js";

const MAX_ARCHIVE_BYTES = 128 * 1024 * 1024;
const MAX_ENTRY_BYTES = 16 * 1024 * 1024;
const MAX_ENTRIES = 10_000;
const MAX_UNITS = 50;

type OrderedNode = Record<string, unknown>;
type OfficeFormat = "docx" | "pptx" | "xlsx";

const xml = new XMLParser({
  preserveOrder: true,
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  processEntities: false,
  allowBooleanAttributes: true,
});

export function extractOffice(bytes: Uint8Array, format: OfficeFormat, sink: DocumentSink): DocumentExtraction {
  const archive = readArchive(bytes);
  if (format === "docx") return extractDocx(archive, sink);
  if (format === "pptx") return extractPptx(archive, sink);
  return extractXlsx(archive, sink);
}

function readArchive(bytes: Uint8Array): Map<string, Uint8Array> {
  let entries = 0;
  let expandedBytes = 0;
  const selected = unzipSync(bytes, {
    filter(info) {
      validateArchivePath(info.name);
      entries += 1;
      expandedBytes += info.originalSize;
      if (entries > MAX_ENTRIES) throw new Error("The Office document exceeds the 10,000-part budget.");
      if (expandedBytes > MAX_ARCHIVE_BYTES) throw new Error("The expanded Office document exceeds the 128 MiB budget.");
      return (info.name.endsWith(".xml") || info.name.endsWith(".rels"))
        && /^(word|ppt|xl)\//.test(info.name);
    },
  });
  return new Map(Object.entries(selected));
}

function validateArchivePath(name: string): void {
  if (!name || name.startsWith("/") || name.includes("\\") || name.includes("\0")
    || name.split("/").some((part) => part === ".." || part === "." || part === "")) {
    throw new Error("The Office document contains an unsafe package path.");
  }
}

function parseXml(archive: Map<string, Uint8Array>, name: string): OrderedNode[] {
  const bytes = archive.get(name);
  if (!bytes) throw new Error(`The Office document is missing ${name}.`);
  if (bytes.byteLength > MAX_ENTRY_BYTES) throw new Error(`${name} exceeds the 16 MiB XML-part budget.`);
  const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (/<!DOCTYPE|<!ENTITY/i.test(source)) throw new Error(`${name} contains unsupported document entities.`);
  return xml.parse(source) as OrderedNode[];
}

function firstTag(node: OrderedNode): string | undefined {
  return Object.keys(node).find((key) => key !== ":@");
}

function children(node: OrderedNode): OrderedNode[] {
  const tag = firstTag(node);
  if (!tag) return [];
  const value = node[tag];
  return Array.isArray(value) ? value as OrderedNode[] : [];
}

function attributes(node: OrderedNode): Record<string, string> {
  const value = node[":@"];
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const record = value as Record<string, unknown>;
  return Object.fromEntries(Object.entries(record).map(([key, item]) => [key.replace(/^@_/, ""), String(item)]));
}

function descendants(nodes: OrderedNode[], tags: ReadonlySet<string>, output: string[]): void {
  for (const node of nodes) {
    if (Object.hasOwn(node, "#text")) {
      output.push(String(node["#text"] ?? ""));
      continue;
    }
    const tag = firstTag(node);
    if (!tag) continue;
    if (tag === "w:tab") {
      output.push("\t");
      continue;
    }
    if (tag === "w:br" || tag === "w:cr") {
      output.push("\n");
      continue;
    }
    if (tags.has(tag)) {
      output.push(...plainText(children(node)));
      continue;
    }
    descendants(children(node), tags, output);
  }
}

function plainText(nodes: OrderedNode[]): string[] {
  const output: string[] = [];
  for (const node of nodes) {
    if (Object.hasOwn(node, "#text")) {
      output.push(String(node["#text"] ?? ""));
      continue;
    }
    output.push(...plainText(children(node)));
  }
  return output;
}

function paragraphTexts(nodes: OrderedNode[], paragraphTag: string, textTags: ReadonlySet<string>): string[] {
  const paragraphs: string[] = [];
  const visit = (items: OrderedNode[]): void => {
    for (const node of items) {
      const tag = firstTag(node);
      if (!tag) continue;
      if (tag === paragraphTag) {
        const parts: string[] = [];
        descendants(children(node), textTags, parts);
        const text = parts.join("").replace(/[ \t]+\n/g, "\n").trim();
        if (text) paragraphs.push(text);
        continue;
      }
      visit(children(node));
    }
  };
  visit(nodes);
  return paragraphs;
}

function appendUnit(sink: DocumentSink, heading: string, lines: string[]): { unit: DocumentExtraction["units"][number]; partial: boolean } {
  const unit = { index: 0, source: heading, extractedCharacters: 0, empty: lines.length === 0, partial: false };
  const before = sink.remaining;
  unit.partial = !sink.append(`\n## ${heading}\n\n${lines.join("\n")}${lines.length ? "\n" : ""}`);
  unit.extractedCharacters = before - sink.remaining;
  return { unit, partial: unit.partial };
}

function extractDocx(archive: Map<string, Uint8Array>, sink: DocumentSink): DocumentExtraction {
  const paragraphs = paragraphTexts(parseXml(archive, "word/document.xml"), "w:p", new Set(["w:t"]));
  const appended = appendUnit(sink, "Word document", paragraphs);
  appended.unit.index = 1;
  return {
    format: "docx",
    unitKind: "document",
    totalUnits: 1,
    units: [appended.unit],
    images: [],
    notes: ["Word text preserves native paragraph and table order.", "Visual page layout requires an Office renderer."],
    truncationReasons: appended.partial ? ["text-budget"] : [],
  };
}

function relationshipMap(archive: Map<string, Uint8Array>, name: string): Map<string, string> {
  const result = new Map<string, string>();
  for (const node of parseXml(archive, name)) {
    if (firstTag(node) !== "Relationships") continue;
    for (const child of children(node)) {
      if (firstTag(child) !== "Relationship") continue;
      const attrs = attributes(child);
      if (attrs.TargetMode?.toLowerCase() === "external") throw new Error("External Office relationships are unavailable.");
      if (attrs.Id && attrs.Target) result.set(attrs.Id, attrs.Target);
    }
  }
  return result;
}

function slidePaths(archive: Map<string, Uint8Array>): string[] {
  const rels = relationshipMap(archive, "ppt/_rels/presentation.xml.rels");
  const ordered: string[] = [];
  const visit = (nodes: OrderedNode[]): void => {
    for (const node of nodes) {
      const tag = firstTag(node);
      if (!tag) continue;
      if (tag === "p:sldId") {
        const target = rels.get(attributes(node)["r:id"] ?? "");
        if (target) ordered.push(`ppt/${target.replace(/^\.\//, "")}`);
        continue;
      }
      visit(children(node));
    }
  };
  visit(parseXml(archive, "ppt/presentation.xml"));
  const discovered = [...archive.keys()]
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((left, right) => Number(left.match(/slide(\d+)\.xml/)?.[1]) - Number(right.match(/slide(\d+)\.xml/)?.[1]));
  return (ordered.length ? ordered : discovered).filter((name, index, all) => all.indexOf(name) === index && archive.has(name));
}

function extractPptx(archive: Map<string, Uint8Array>, sink: DocumentSink): DocumentExtraction {
  const slides = slidePaths(archive);
  const result: DocumentExtraction = {
    format: "pptx", unitKind: "slide", totalUnits: slides.length, units: [], images: [],
    notes: ["PowerPoint text follows native slide order.", "Visual slide layout requires an Office renderer."],
    truncationReasons: slides.length > MAX_UNITS ? ["unit-budget"] : [],
  };
  for (const [index, name] of slides.slice(0, MAX_UNITS).entries()) {
    if (!sink.remaining) {
      if (!result.truncationReasons.includes("text-budget")) result.truncationReasons.push("text-budget");
      break;
    }
    const lines = paragraphTexts(parseXml(archive, name), "a:p", new Set(["a:t"]));
    const appended = appendUnit(sink, `Slide ${index + 1}`, lines);
    appended.unit.index = index + 1;
    result.units.push(appended.unit);
    if (appended.partial) {
      if (!result.truncationReasons.includes("text-budget")) result.truncationReasons.push("text-budget");
      break;
    }
  }
  return result;
}

function sharedStrings(archive: Map<string, Uint8Array>): string[] {
  const file = archive.get("xl/sharedStrings.xml");
  if (!file) return [];
  const strings: string[] = [];
  for (const node of parseXml(archive, "xl/sharedStrings.xml")) {
    if (firstTag(node) !== "x:sst" && firstTag(node) !== "sst") continue;
    for (const item of children(node).filter((child) => firstTag(child) === "x:si" || firstTag(child) === "si")) {
      strings.push(plainText(children(item)).join(""));
    }
  }
  return strings;
}

function sheetPaths(archive: Map<string, Uint8Array>): Array<{ name: string; path: string }> {
  const rels = relationshipMap(archive, "xl/_rels/workbook.xml.rels");
  const sheets: Array<{ name: string; path: string }> = [];
  const visit = (nodes: OrderedNode[]): void => {
    for (const node of nodes) {
      const tag = firstTag(node);
      if (!tag) continue;
      if (tag === "x:sheet") {
        const attrs = attributes(node);
        const target = rels.get(attrs["r:id"] ?? "");
        if (target) sheets.push({ name: attrs.name || `Sheet ${sheets.length + 1}`, path: `xl/${target.replace(/^\.\//, "")}` });
        continue;
      }
      visit(children(node));
    }
  };
  visit(parseXml(archive, "xl/workbook.xml"));
  return sheets.filter((sheet) => archive.has(sheet.path));
}

function cellText(node: OrderedNode, strings: string[]): string {
  const attrs = attributes(node);
  let raw = "";
  let inline = "";
  for (const child of children(node)) {
    const tag = firstTag(child);
    if (tag === "x:v") raw += plainText(children(child)).join("");
    if (tag === "x:is") inline += plainText(children(child)).join("");
  }
  if (inline) return inline;
  if (attrs.t === "s") return strings[Number(raw)] ?? "";
  if (attrs.t === "b") return raw === "1" ? "TRUE" : "FALSE";
  return raw;
}

function worksheetRows(nodes: OrderedNode[], strings: string[]): string[] {
  const rows: string[] = [];
  const visit = (items: OrderedNode[]): void => {
    for (const node of items) {
      const tag = firstTag(node);
      if (!tag) continue;
      if (tag === "x:row") {
        const cells = children(node).filter((child) => firstTag(child) === "x:c").map((cell) => cellText(cell, strings));
        if (cells.some((cell) => cell !== "")) rows.push(cells.join("\t"));
        continue;
      }
      visit(children(node));
    }
  };
  visit(nodes);
  return rows;
}

function extractXlsx(archive: Map<string, Uint8Array>, sink: DocumentSink): DocumentExtraction {
  const sheets = sheetPaths(archive);
  const strings = sharedStrings(archive);
  const result: DocumentExtraction = {
    format: "xlsx", unitKind: "sheet", totalUnits: sheets.length, units: [], images: [],
    notes: ["Excel rows preserve native worksheet order and cached cell values.", "Formulas are not recalculated."],
    truncationReasons: sheets.length > MAX_UNITS ? ["unit-budget"] : [],
  };
  for (const [index, sheet] of sheets.slice(0, MAX_UNITS).entries()) {
    if (!sink.remaining) {
      if (!result.truncationReasons.includes("text-budget")) result.truncationReasons.push("text-budget");
      break;
    }
    const rows = worksheetRows(parseXml(archive, sheet.path), strings);
    const appended = appendUnit(sink, `Sheet: ${sheet.name}`, rows);
    appended.unit.index = index + 1;
    result.units.push(appended.unit);
    if (appended.partial) {
      if (!result.truncationReasons.includes("text-budget")) result.truncationReasons.push("text-budget");
      break;
    }
  }
  return result;
}
