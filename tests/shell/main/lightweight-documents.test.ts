import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { zipSync, strToU8 } from "fflate";
import { prepareLightDocument } from "../../../shell/main/attachments/lightweight-documents.js";
import { DocumentParserRegistry } from "../../../shell/main/attachments/document-parsers.js";

function officePackage(parts: Record<string, string>): Uint8Array {
  return zipSync(Object.fromEntries(Object.entries(parts).map(([name, value]) => [name, strToU8(value)])));
}

function pdf(text: string): Uint8Array {
  const stream = `BT /F1 24 Tf 72 700 Td (${text}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Count 1 /Kids [3 0 R] >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let result = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(result));
    result += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(result);
  result += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  result += offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  result += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return strToU8(result);
}

test("lightweight PDF extraction keeps embedded text and bounded page images", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "lightweight-pdf-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = join(directory, "sample.pdf");
  await writeFile(source, pdf("PDF_LIGHTWEIGHT_SENTINEL"));
  const result = await prepareLightDocument({
    path: source, name: "sample.pdf", mediaType: "application/pdf", outputDirectory: join(directory, "out"),
  });
  assert.match(result.text, /PDF_LIGHTWEIGHT_SENTINEL/);
  assert.match(result.text, /OCR is not performed/);
  assert.equal(result.images.length, 1);
  assert.equal(result.previewFile, "page-1.jpg");
  assert.equal((await readFile(join(directory, "out/page-1.jpg"))).subarray(0, 2).toString("hex"), "ffd8");
});

test("lightweight OOXML reads Word paragraphs, PowerPoint order and Excel cached cells", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "lightweight-office-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const fixtures = {
    "sample.docx": officePackage({
      "word/document.xml": `<?xml version="1.0" encoding="UTF-8"?>
        <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
        <w:p><w:r><w:t>WORD_SENTINEL</w:t></w:r></w:p>
        <w:tbl><w:tr><w:tc><w:p><w:r><w:t>TABLE_SENTINEL</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
        </w:body></w:document>`,
    }),
    "sample.pptx": officePackage({
      "ppt/presentation.xml": `<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst><p:sldId id="1" r:id="rId2"/><p:sldId id="2" r:id="rId1"/></p:sldIdLst></p:presentation>`,
      "ppt/_rels/presentation.xml.rels": `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="slides/slide1.xml" Type="slide"/><Relationship Id="rId2" Target="slides/slide2.xml" Type="slide"/></Relationships>`,
      "ppt/slides/slide1.xml": `<p:sld xmlns:p="urn:p" xmlns:a="urn:a"><a:p><a:r><a:t>SLIDE_ONE</a:t></a:r></a:p></p:sld>`,
      "ppt/slides/slide2.xml": `<p:sld xmlns:p="urn:p" xmlns:a="urn:a"><a:p><a:r><a:t>SLIDE_TWO</a:t></a:r></a:p></p:sld>`,
    }),
    "sample.xlsx": officePackage({
      "xl/workbook.xml": `<x:workbook xmlns:x="urn:x" xmlns:r="urn:r"><x:sheets><x:sheet name="Budget" r:id="rId1"/></x:sheets></x:workbook>`,
      "xl/_rels/workbook.xml.rels": `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="worksheets/sheet1.xml" Type="worksheet"/></Relationships>`,
      "xl/sharedStrings.xml": `<x:sst xmlns:x="urn:x"><x:si><x:t>SHEET_SENTINEL</x:t></x:si></sst>`,
      "xl/worksheets/sheet1.xml": `<x:worksheet xmlns:x="urn:x"><x:sheetData><x:row><x:c r="A1" t="s"><x:v>0</x:v></x:c><x:c r="B1"><x:v>42</x:v></x:c></x:row></x:sheetData></x:worksheet>`,
    }),
  };
  for (const [name, bytes] of Object.entries(fixtures)) {
    const source = join(directory, name);
    await writeFile(source, bytes);
    const result = await prepareLightDocument({
      path: source, name, mediaType: "application/octet-stream", outputDirectory: join(directory, `${name}-out`),
    });
    if (name.endsWith(".docx")) {
      assert.match(result.text, /WORD_SENTINEL/);
      assert.match(result.text, /TABLE_SENTINEL/);
    } else if (name.endsWith(".pptx")) {
      assert.ok(result.text.indexOf("SLIDE_TWO") < result.text.indexOf("SLIDE_ONE"));
    } else {
      assert.match(result.text, /SHEET_SENTINEL\t42/);
      assert.match(result.text, /Formulas are not recalculated/);
    }
  }
});

test("parser registry defaults to lightweight and exposes Docling only when its runtime exists", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "attachment-parsers-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const runtime = join(directory, "runtime");
  const worker = join(directory, "docling_worker.py");
  const installer = join(directory, "install.mjs");
  await writeFile(worker, "worker");
  await writeFile(installer, `
    import { mkdir, writeFile } from 'node:fs/promises';
    import { join } from 'node:path';
    const index = process.argv.indexOf('--directory');
    const runtime = process.argv[index + 1];
    await mkdir(join(runtime, 'venv', 'bin'), { recursive: true });
    await mkdir(join(runtime, 'models'), { recursive: true });
    await writeFile(join(runtime, 'venv', 'bin', 'python'), 'python');
    await writeFile(join(runtime, 'models', 'model.bin'), 'model');
  `);
  const registry = new DocumentParserRegistry({
    settingsPath: join(directory, "processing.json"),
    runtimeDirectory: runtime,
    doclingWorkerPath: worker,
    installScriptPath: installer,
  });
  await registry.initialize();
  const initial = await registry.settings();
  assert.equal(initial.documentParserId, "lightweight");
  assert.equal(initial.parsers.find((parser) => parser.parserId === "docling")?.available, false);
  assert.equal(registry.processor.identity, "lightweight@1");
  await assert.rejects(() => registry.select("docling"), /Download the advanced parser/);

  const ready = await registry.install("docling");
  assert.equal(ready.parsers.find((parser) => parser.parserId === "docling")?.available, true);
  assert.equal((await registry.select("docling")).documentParserId, "docling");
  assert.equal(registry.processor.identity, "docling@2.142.1");
  await registry.dispose();
});
