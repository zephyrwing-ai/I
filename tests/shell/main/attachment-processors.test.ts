import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, chmod, mkdtemp, readFile, readdir, stat, symlink, writeFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setImmediate as immediate, setTimeout as delay } from "node:timers/promises";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";
import { createAttachmentProcessor, type AttachmentPreparation } from "../../../shell/main/attachments/processors.js";

const exec = promisify(execFile);
const workerPath = resolve("resources/attachments/docling_worker.py");

async function workspace(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "attachment-processors-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = join(directory, "source with spaces.bin");
  await writeFile(source, "fixture");
  return { directory, source, output: join(directory, "output"), runtime: join(directory, "runtime") };
}

async function fixture(directory: string, name: string, body: string): Promise<string> {
  const path = join(directory, `${name}.mjs`);
  await writeFile(path, `#!${process.execPath}\n${body}`, { mode: 0o755 });
  await chmod(path, 0o755);
  return path;
}

const validProbe = { format: { duration: "6.0" }, streams: [
  { index: 2, codec_type: "video", width: 640, height: 360, duration: "N/A", avg_frame_rate: "24/1", disposition: { attached_pic: 0 } },
] };

function prepared(overrides: Partial<AttachmentPreparation> = {}): AttachmentPreparation {
  return { text: "Coverage: source page 1 of 1.", images: [], truncated: false, ...overrides };
}

test("text preserves source lines and UTF-8 with complete coverage", async (t) => {
  const { source, output, runtime } = await workspace(t);
  await writeFile(source, "第一行\r\n\nconst greeting = '你好';\n");
  const result = await createAttachmentProcessor({ runtimeDirectory: runtime, workerPath })({ path: source, name: "source.ts", mediaType: "application/octet-stream", outputDirectory: output });
  assert.equal(result.truncated, false);
  assert.match(result.text, /Coverage: complete UTF-8 text/);
  assert.match(result.text, /1 \| 第一行\n2 \| \n3 \| const greeting = '你好';\n4 \| $/);
  assert.deepEqual(result.images, []);
});

test("text budgets include line numbers and declare a truncated prefix", async (t) => {
  const { source, output, runtime } = await workspace(t);
  const processAttachment = createAttachmentProcessor({ runtimeDirectory: runtime, workerPath });
  for (const text of ["x\n".repeat(700_000), "x".repeat(2 * 1024 * 1024 - 1) + "中文suffix"]) {
    await writeFile(source, text);
    const result = await processAttachment({ path: source, name: "many-lines.ts", mediaType: "text/plain", outputDirectory: output });
    assert.equal(result.truncated, true);
    assert.ok(result.text.length <= 1_900_000);
    assert.match(result.text, /Coverage: prefix through source line/);
    assert.doesNotMatch(result.text, /Coverage: complete/);
    assert.doesNotMatch(result.text, /\uFFFD/);
  }
});

test("text rejects binary controls and invalid UTF-8", async (t) => {
  const { source, output, runtime } = await workspace(t);
  const processAttachment = createAttachmentProcessor({ runtimeDirectory: runtime, workerPath });
  for (const bytes of [Buffer.from([65, 0, 66]), Buffer.from([0xc3, 0x28]), Buffer.from([0xff, 0xfe, 0x41, 0])]) {
    await writeFile(source, bytes);
    await assert.rejects(processAttachment({ path: source, name: "data", mediaType: "application/octet-stream", outputDirectory: output }), /binary data|invalid UTF-8/);
  }
});

test("images await the native normalizer and publish relative files", async (t) => {
  const { source, output, runtime } = await workspace(t);
  let called = false;
  const processAttachment = createAttachmentProcessor({ runtimeDirectory: runtime, workerPath,
    normalizeImage: async (path, directory) => {
      assert.equal(path, source);
      assert.notEqual(directory, output);
      await immediate();
      await writeFile(join(directory, "normalized.png"), "pixels");
      called = true;
      return prepared({ images: [{ fileName: "normalized.png", mediaType: "image/png", label: "User image" }], previewFile: "normalized.png" });
    } });
  const result = await processAttachment({ path: source, name: "image.png", mediaType: "image/png", outputDirectory: output });
  assert.equal(called, true);
  assert.equal(result.previewFile, "normalized.png");
  assert.equal(await readFile(join(output, "normalized.png"), "utf8"), "pixels");
  assert.deepEqual(await readdir(output), ["normalized.png"]);
});

test("derivative validation rejects traversal, symlinks and unagreed media types", async (t) => {
  const { source, output, runtime } = await workspace(t);
  for (const fileName of ["../outside.png", "/absolute.png", "bad\\name.png", ".hidden.png", "link.png", "image.webp"]) {
    const processAttachment = createAttachmentProcessor({ runtimeDirectory: runtime, workerPath,
      normalizeImage: async (_path, directory) => {
        if (fileName === "link.png") await symlink(source, join(directory, fileName));
        else await writeFile(join(directory, "safe.png"), "safe");
        return prepared({ images: [{ fileName, mediaType: fileName.endsWith(".webp") ? "image/webp" : "image/png", label: "Image" }] });
      } });
    await assert.rejects(processAttachment({ path: source, name: "image.png", mediaType: "image/png", outputDirectory: output }), /invalid preparation|unsafe derivative/);
    assert.deepEqual(await readdir(output), []);
  }
});

test("publication preserves existing files and cleans partial publication", async (t) => {
  const { source, output, runtime } = await workspace(t);
  const processAttachment = createAttachmentProcessor({ runtimeDirectory: runtime, workerPath,
    normalizeImage: async (_path, directory) => {
      await writeFile(join(directory, "a.png"), "new a");
      await writeFile(join(directory, "b.png"), "new b");
      return prepared({ images: [{ fileName: "a.png", mediaType: "image/png", label: "Image" }] });
    } });
  const { mkdir } = await import("node:fs/promises");
  await mkdir(output);
  await writeFile(join(output, "b.png"), "existing");
  await assert.rejects(processAttachment({ path: source, name: "image.png", mediaType: "image/png", outputDirectory: output }), /EEXIST/);
  assert.deepEqual(await readdir(output), ["b.png"]);
  assert.equal(await readFile(join(output, "b.png"), "utf8"), "existing");
});

test("document worker receives explicit arguments, offline environment and publishes caches", async (t) => {
  const { directory, source, output, runtime } = await workspace(t);
  const record = join(directory, "arguments.json");
  const python = await fixture(directory, "python fixture", `
import fs from 'node:fs'; import path from 'node:path';
const args = process.argv.slice(2); const out = args[args.indexOf('--output-directory') + 1];
fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify({args, env: {offline:process.env.HF_HUB_OFFLINE,transformers:process.env.TRANSFORMERS_OFFLINE,threads:process.env.OMP_NUM_THREADS}}));
fs.writeFileSync(path.join(out,'document.md'),'# Source page 1');
fs.writeFileSync(path.join(out,'document.json'),'{}');
console.log(${JSON.stringify(JSON.stringify(prepared()))});`);
  const processAttachment = createAttachmentProcessor({ runtimeDirectory: runtime, workerPath, pythonPath: python });
  const result = await processAttachment({ path: source, name: "user ; $(touch injected).pdf", mediaType: "application/pdf", outputDirectory: output });
  assert.equal(result.truncated, false);
  const recordValue = JSON.parse(await readFile(record, "utf8"));
  assert.equal(recordValue.args[0], "-I");
  assert.equal(recordValue.args[1], workerPath);
  assert.equal(recordValue.args[recordValue.args.indexOf("--input") + 1], source);
  assert.equal(recordValue.args[recordValue.args.indexOf("--max-pages") + 1], "50");
  assert.equal(recordValue.args[recordValue.args.indexOf("--format") + 1], ".pdf");
  assert.deepEqual(recordValue.env, { offline: "1", transformers: "1", threads: "2" });
  assert.deepEqual((await readdir(output)).sort(), ["document.json", "document.md"]);
});

test("missing explicit executables give an actionable setup error", async (t) => {
  const { directory, source, output, runtime } = await workspace(t);
  for (const overrides of [{ pythonPath: join(directory, "missing-python"), name: "document.pdf", mediaType: "application/pdf" },
    { ffprobePath: join(directory, "missing-probe"), name: "clip.mp4", mediaType: "video/mp4" }]) {
    const processAttachment = createAttachmentProcessor({ runtimeDirectory: runtime, workerPath, ...overrides });
    await assert.rejects(processAttachment({ path: source, name: overrides.name, mediaType: overrides.mediaType, outputDirectory: output }), /npm run setup:attachments/);
    assert.deepEqual(await readdir(output), []);
  }
});

test("worker failures, malformed output and output floods stay bounded and leave no artifacts", async (t) => {
  const { directory, source, output, runtime } = await workspace(t);
  const cases: Array<[string, RegExp]> = [
    ["process.stderr.write('missing model: npm run setup:attachments'); process.exit(7);", /exited with 7: missing model/],
    ["console.log('not-json');", /invalid JSON/],
    ["console.log('{}');", /invalid preparation/],
    ["process.stdout.write('x'.repeat(2*1024*1024)); setInterval(()=>{},1000);", /stdout limit/],
    ["process.stderr.write('x'.repeat(64*1024)); setInterval(()=>{},1000);", /stderr limit/],
  ];
  for (let index = 0; index < cases.length; index++) {
    const [body, expected] = cases[index];
    const python = await fixture(directory, `failure-${index}`, body);
    const processAttachment = createAttachmentProcessor({ runtimeDirectory: runtime, workerPath, pythonPath: python });
    await assert.rejects(processAttachment({ path: source, name: "file.pdf", mediaType: "application/pdf", outputDirectory: output }), expected);
    assert.deepEqual(await readdir(output), []);
  }
});

test("abort terminates the document process and cleans its private output", async (t) => {
  const { directory, source, output, runtime } = await workspace(t);
  const started = join(directory, "started");
  const python = await fixture(directory, "waiting-worker", `
import fs from 'node:fs'; import path from 'node:path';
const args=process.argv.slice(2); fs.writeFileSync(path.join(args[args.indexOf('--output-directory')+1],'partial.json'),'partial');
fs.writeFileSync(${JSON.stringify(started)}, String(process.pid)); setInterval(()=>{},1000);`);
  const controller = new AbortController();
  const result = createAttachmentProcessor({ runtimeDirectory: runtime, workerPath, pythonPath: python })({ path: source, name: "file.pdf", mediaType: "application/pdf", outputDirectory: output }, controller.signal);
  const rejection = assert.rejects(result, { name: "AbortError" });
  for (let index = 0; index < 200; index++) {
    try { await access(started); break; } catch { await delay(10); }
  }
  const pid = Number(await readFile(started, "utf8"));
  controller.abort();
  await rejection;
  assert.throws(() => process.kill(pid, 0), /ESRCH/);
  assert.deepEqual(await readdir(output), []);
});

test("worker timeout reaps the process before cleanup", async (t) => {
  const { directory, source, output, runtime } = await workspace(t);
  const started = join(directory, "timeout-started");
  const python = await fixture(directory, "timeout-worker", `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(started)},String(process.pid)); setInterval(()=>{},1000);`);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const result = createAttachmentProcessor({ runtimeDirectory: runtime, workerPath, pythonPath: python })({ path: source, name: "file.pdf", mediaType: "application/pdf", outputDirectory: output });
  const rejection = assert.rejects(result, /timed out after 180 seconds/);
  for (let index = 0; index < 10_000; index++) {
    try { await access(started); break; } catch { await immediate(); }
  }
  const pid = Number(await readFile(started, "utf8"));
  t.mock.timers.tick(180_001);
  await rejection;
  assert.throws(() => process.kill(pid, 0), /ESRCH/);
  assert.deepEqual(await readdir(output), []);
});

test("video probes visual streams and requests six bounded JPEG samples without a shell", async (t) => {
  const { directory, output, runtime } = await workspace(t);
  const source = join(directory, "clip ; $(touch INJECTED) '你好'.mp4");
  await writeFile(source, "video fixture");
  const calls = join(directory, "calls.jsonl");
  const probe = await fixture(directory, "probe", `console.log(${JSON.stringify(JSON.stringify(validProbe))});`);
  const ffmpeg = await fixture(directory, "ffmpeg", `import fs from 'node:fs'; const args=process.argv.slice(2); fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify(args)+String.fromCharCode(10)); fs.writeFileSync(args.at(-1),Buffer.from([255,216,255,217]));`);
  const result = await createAttachmentProcessor({ runtimeDirectory: runtime, workerPath, ffprobePath: probe, ffmpegPath: ffmpeg })({ path: source, name: "video.mp4", mediaType: "video/mp4", outputDirectory: output });
  assert.equal(result.durationSeconds, 6);
  assert.equal(result.truncated, true);
  assert.equal(result.previewFile, "frame-1.jpg");
  assert.equal(result.images.length, 6);
  const argumentsList: string[][] = (await readFile(calls, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(argumentsList.map((args) => args[args.indexOf("-ss") + 1]), ["0.000000", "1.000000", "2.000000", "3.000000", "4.000000", "5.000000"]);
  for (const args of argumentsList) {
    assert.equal(args[args.indexOf("-i") + 1], source);
    assert.equal(args[args.indexOf("-map") + 1], "0:2");
    assert.ok(args.includes("-an"));
    assert.equal(args[args.indexOf("-protocol_whitelist") + 1], "file,pipe");
    assert.equal(args[args.indexOf("-threads") + 1], "2");
  }
  assert.match(result.text, /Audio coverage: visual sampling only/);
  assert.equal((await readdir(output)).length, 6);
  await assert.rejects(access(join(directory, "INJECTED")));
});

test("video rejects audio-only, cover art and invalid duration before frame extraction", async (t) => {
  const { directory, source, output, runtime } = await workspace(t);
  const ffmpeg = await fixture(directory, "unused-ffmpeg", "process.exit(99);");
  const cases = [
    { format: { duration: "5" }, streams: [{ codec_type: "audio" }] },
    { format: { duration: "5" }, streams: [{ ...validProbe.streams[0], disposition: { attached_pic: 1 } }] },
    { format: { duration: "Infinity" }, streams: [{ ...validProbe.streams[0], duration: "Infinity" }] },
  ];
  for (let index = 0; index < cases.length; index++) {
    const probe = await fixture(directory, `invalid-probe-${index}`, `console.log(${JSON.stringify(JSON.stringify(cases[index]))});`);
    await assert.rejects(createAttachmentProcessor({ runtimeDirectory: runtime, workerPath, ffprobePath: probe, ffmpegPath: ffmpeg })({ path: source, name: "video.mp4", mediaType: "video/mp4", outputDirectory: output }), /no visual video stream|finite positive duration/);
    assert.deepEqual(await readdir(output), []);
  }
});

async function systemExecutable(name: string): Promise<string | undefined> {
  for (const path of [`/opt/homebrew/bin/${name}`, `/usr/local/bin/${name}`, `/usr/bin/${name}`]) {
    try { await access(path); return path; } catch { /* Optional real-engine coverage. */ }
  }
  return undefined;
}

test("real FFmpeg produces six decodable frames for changing and single-frame videos", async (t) => {
  const ffmpeg = await systemExecutable("ffmpeg");
  const ffprobe = await systemExecutable("ffprobe");
  if (!ffmpeg || !ffprobe) { t.skip("FFmpeg/FFprobe are optional system engines."); return; }
  const { directory, runtime } = await workspace(t);
  for (const [name, duration] of [["changing", "3"], ["single-frame", "0.05"]]) {
    const source = join(directory, `${name}.mp4`);
    await exec(ffmpeg, ["-hide_banner", "-loglevel", "error", "-nostdin", "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=20", "-t", duration, "-c:v", "mpeg4", "-threads", "2", "-y", source], { timeout: 30_000 });
    const output = join(directory, `${name}-output`);
    const result: AttachmentPreparation = await createAttachmentProcessor({ runtimeDirectory: runtime, workerPath, ffmpegPath: ffmpeg, ffprobePath: ffprobe })({ path: source, name: `${name}.mp4`, mediaType: "video/mp4", outputDirectory: output });
    assert.equal(result.images.length, 6);
    assert.ok(Math.abs(result.durationSeconds! - Number(duration)) < 0.1);
    for (const image of result.images) {
      const bytes = await readFile(join(output, image.fileName));
      assert.equal(bytes.subarray(0, 2).toString("hex"), "ffd8");
      const probeOutput: { stdout: string; stderr: string } = await exec(ffprobe, ["-v", "error", "-show_entries", "stream=codec_name,width,height", "-of", "json", join(output, image.fileName)]);
      const info: { codec_name: string; width: number; height: number } = JSON.parse(probeOutput.stdout).streams[0];
      assert.equal(info.codec_name, "mjpeg");
      assert.equal(info.width, 1280);
      assert.equal(info.height, 960);
    }
    if (name === "changing") {
      const first = await readFile(join(output, result.images[0].fileName));
      const last = await readFile(join(output, result.images[5].fileName));
      assert.notDeepEqual(first, last);
    }
  }
});

test("setup help is read-only and unknown options fail before installation", async () => {
  const script = resolve("scripts/setup-attachments.mjs");
  const { stdout } = await exec(process.execPath, [script, "--help"]);
  assert.match(stdout, /Python 3.12/);
  assert.match(stdout, /2.142.1/);
  assert.match(stdout, /--models-only/);
  await assert.rejects(exec(process.execPath, [script, "--unknown"]), /Unknown attachment setup option/);
});

test("real Docling converts Office structures, PDF text and scanned OCR with page provenance", { timeout: 600_000 }, async (t) => {
  const runtime = process.env.ATTACHMENT_TEST_RUNTIME_DIRECTORY
    ?? join(homedir(), "Library", "Application Support", "I", "attachment-runtime");
  const python = join(runtime, "venv", "bin", "python");
  try {
    await exec(python, ["-I", "-c", "import importlib.metadata,sys; assert sys.version_info[:2] == (3,12); assert importlib.metadata.version('docling-slim') == '2.142.1'"], { timeout: 15_000 });
  } catch { t.skip("Run npm run setup:attachments, then set ATTACHMENT_TEST_RUNTIME_DIRECTORY for a custom runtime."); return; }
  const { directory } = await workspace(t);
  // All fixtures use libraries already in the isolated Docling environment.
  const makeFixtures = String.raw`
from pathlib import Path
from io import BytesIO
import sys
from docx import Document
from pptx import Presentation
from pptx.util import Inches
from openpyxl import Workbook
from PIL import Image,ImageDraw,ImageFont
directory=Path(sys.argv[1])
doc=Document(); doc.add_heading('Office source text',0); doc.add_paragraph('NATIVE_WORD_SENTINEL'); doc.save(directory/'fixture.docx')
prs=Presentation()
for i in range(52):
    slide=prs.slides.add_slide(prs.slide_layouts[6]); slide.shapes.add_textbox(Inches(1), Inches(1), Inches(7), Inches(2)).text=f'SLIDE_SENTINEL_{i+1}'
prs.save(directory/'fixture.pptx')
wb=Workbook(); ws=wb.active; ws.title='Budget'; ws.append(['Product','Count']); ws.append(['NATIVE_SHEET_SENTINEL',42]); wb.save(directory/'fixture.xlsx')
def pdf(path, streams):
    objects=[b'<< /Type /Catalog /Pages 2 0 R >>', ('<< /Type /Pages /Count %d /Kids [%s] >>'%(len(streams),' '.join(f'{4+2*i} 0 R' for i in range(len(streams))))).encode(), b'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>']
    for i,stream in enumerate(streams):
        objects.append(('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents %d 0 R >>'%(5+2*i)).encode())
        objects.append(('<< /Length %d >>\nstream\n'%len(stream)).encode()+stream+b'\nendstream')
    result=b'%PDF-1.4\n'; offsets=[0]
    for i,obj in enumerate(objects,1): offsets.append(len(result)); result+=f'{i} 0 obj\n'.encode()+obj+b'\nendobj\n'
    start=len(result); result+=f'xref\n0 {len(objects)+1}\n0000000000 65535 f \n'.encode()
    result+=b''.join(f'{offset:010d} 00000 n \n'.encode() for offset in offsets[1:])
    result+=f'trailer\n<< /Size {len(objects)+1} /Root 1 0 R >>\nstartxref\n{start}\n%%EOF'.encode(); path.write_bytes(result)
pdf(directory/'fixture.pdf',[b'BT /F1 24 Tf 72 700 Td (PDF_SOURCE_SENTINEL page one) Tj ET',b'BT /F1 24 Tf 72 700 Td (PDF_SOURCE_SENTINEL page two) Tj ET'])
image=Image.new('RGB',(1400,700),'white'); draw=ImageDraw.Draw(image)
fonts=['/System/Library/Fonts/Supplemental/Arial.ttf','/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf']
font=next((ImageFont.truetype(p,62) for p in fonts if Path(p).exists()), ImageFont.load_default(size=62))
draw.text((80,200),'SCANNED DOCUMENT 2846',fill='black',font=font); image.save(directory/'scan.pdf','PDF',resolution=140)
`;
  await exec(python, ["-I", "-c", makeFixtures, directory], { timeout: 30_000 });
  const processAttachment = createAttachmentProcessor({ runtimeDirectory: runtime, workerPath, pythonPath: python });
  for (const [name, expected] of [["fixture.docx", /NATIVE_WORD_SENTINEL/], ["fixture.pptx", /SLIDE_SENTINEL_50/], ["fixture.xlsx", /NATIVE_SHEET_SENTINEL/], ["fixture.pdf", /PDF_SOURCE_SENTINEL/], ["scan.pdf", /2846/]] as const) {
    await t.test(name, async () => {
      const output = join(directory, name + "-output");
      const result = await processAttachment({ path: join(directory, name), name, mediaType: "application/octet-stream", outputDirectory: output });
      assert.match(result.text.replace(/\\_/g, "_"), expected);
      assert.match(result.text, /Coverage:/);
      const cache = JSON.parse(await readFile(join(output, "document.json"), "utf8"));
      assert.ok(cache.document.body);
      const markdown = await readFile(join(output, "document.md"), "utf8");
      assert.match(markdown.replace(/\\_/g, "_"), expected);
      if (name === "fixture.pptx") {
        assert.equal(result.truncated, true);
        assert.equal(cache.coverage.totalSourceUnits, 52);
        assert.equal(cache.coverage.convertedSourceUnits.length, 50);
        assert.doesNotMatch(markdown.replace(/\\_/g, "_"), /SLIDE_SENTINEL_51/);
      } else assert.equal(result.truncated, false);
      if (name.endsWith(".pdf")) {
        assert.equal(result.images.length, name === "scan.pdf" ? 1 : 2);
        assert.equal(result.previewFile, "page-1.jpg");
        assert.ok(cache.document.texts.some((item: { prov?: unknown[] }) => item.prov?.length));
        assert.ok((await stat(join(output, result.previewFile!))).size > 500);
      } else assert.equal(result.images.length, 0);
    });
  }
});
