import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, link, lstat, mkdir, mkdtemp, open, readdir, rm } from "node:fs/promises";
import { delimiter, extname, isAbsolute, join, resolve } from "node:path";

export interface AttachmentPreparation {
  text: string;
  images: Array<{ fileName: string; mediaType: string; label: string }>;
  previewFile?: string;
  durationSeconds?: number;
  truncated: boolean;
}

export interface AttachmentProcessorInput {
  path: string;
  name: string;
  mediaType: string;
  outputDirectory: string;
  documentFormat?: string;
}

export interface AttachmentProcessor {
  (input: AttachmentProcessorInput, signal?: AbortSignal): Promise<AttachmentPreparation>;
  /** Cache identity changes whenever the selected parser or version changes. */
  readonly identity?: string;
}

const TEXT_BYTES = 2 * 1024 * 1024;
const PREPARED_TEXT_CHARACTERS = 1_900_000;
const OUTPUT_BYTES = 1024 * 1024;
const STDERR_BYTES = 32 * 1024;
const DOCUMENT_TIMEOUT = 180_000;
const VIDEO_TIMEOUT = 30_000;
const SETUP = "Run npm run setup:attachments (or node scripts/setup-attachments.mjs).";
const DOCUMENT_TYPES: Record<string, string> = {
  "application/pdf": ".pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": ".pptx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
};
const DOCUMENT_EXTENSIONS = new Set([".pdf", ".docx", ".pptx", ".xlsx"]);
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".tif", ".tiff", ".svg", ".avif", ".heic", ".ico"]);
const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".m4v", ".mkv", ".webm", ".avi", ".mpeg", ".mpg", ".3gp", ".mts", ".m2ts"]);

function abortError(): Error {
  return Object.assign(new Error("Attachment preparation was cancelled."), { name: "AbortError" });
}

function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

function safeFileName(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,159}$/.test(value);
}

async function executable(name: string, runtime: string, override?: string): Promise<string> {
  const file = process.platform === "win32" ? `${name}.exe` : name;
  const candidates = override
    ? (isAbsolute(override) || override.includes("/") || override.includes("\\")
      ? [resolve(override)]
      : (process.env.PATH ?? "").split(delimiter).filter(Boolean).map((dir) => join(dir, override)))
    : [
      join(runtime, "bin", file),
      ...(name === "python3.12" ? [join(runtime, "venv", "bin", "python"), join(runtime, "venv", "Scripts", "python.exe")] : []),
      join("/opt/homebrew/bin", file), join("/usr/local/bin", file),
      ...(process.env.PATH ?? "").split(delimiter).filter(Boolean).map((dir) => join(dir, file)),
    ];
  for (const candidate of candidates) {
    try {
      await access(candidate, process.platform === "win32" ? constants.F_OK : constants.X_OK);
      if ((await lstat(candidate)).isDirectory()) continue;
      return candidate;
    } catch { /* Continue through the ordered executable locations. */ }
  }
  throw new Error(`Attachment engine ${name}${override ? ` (${override})` : ""} is unavailable. ${SETUP}`);
}

// Each invocation owns a process group, its output budget, and its cancellation lifecycle.
async function run(
  command: string,
  args: string[],
  timeout: number,
  signal?: AbortSignal,
  env?: NodeJS.ProcessEnv,
): Promise<string> {
  checkAbort(signal);
  return new Promise((resolveResult, reject) => {
    const child = spawn(command, args, {
      shell: false, windowsHide: true, detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"], env: env ?? process.env,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let failure: Error | undefined;
    let escalation: ReturnType<typeof setTimeout> | undefined;
    const kill = (kind: NodeJS.Signals) => {
      try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, kind);
        else child.kill(kind);
      } catch { /* The process may have exited before delivery. */ }
    };
    const stop = (error: Error) => {
      if (failure) return;
      failure = error;
      kill("SIGTERM");
      escalation = setTimeout(() => kill("SIGKILL"), 500);
    };
    const onAbort = () => stop(abortError());
    const timer = setTimeout(() => stop(new Error(`Attachment engine timed out after ${timeout / 1000} seconds.`)), timeout);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > OUTPUT_BYTES) stop(new Error("Attachment engine exceeded its stdout limit."));
      else stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const remaining = STDERR_BYTES - stderrBytes;
      if (remaining > 0) stderr.push(chunk.subarray(0, remaining));
      stderrBytes += chunk.length;
      if (stderrBytes > STDERR_BYTES) stop(new Error("Attachment engine exceeded its stderr limit."));
    });
    child.on("error", (error) => { failure ??= new Error(`Attachment engine failed to start: ${error.message}. ${SETUP}`); });
    child.on("close", (code, termination) => {
      clearTimeout(timer);
      if (escalation) clearTimeout(escalation);
      // Reap descendants that outlive their leader after cancellation.
      if (failure) kill("SIGKILL");
      signal?.removeEventListener("abort", onAbort);
      if (failure) reject(failure);
      else if (code !== 0) reject(new Error(`Attachment engine exited with ${code ?? termination}: ${Buffer.concat(stderr).toString("utf8").trim()}`));
      else resolveResult(Buffer.concat(stdout).toString("utf8"));
    });
  });
}

async function prepareText(path: string, signal?: AbortSignal): Promise<AttachmentPreparation> {
  const handle = await open(path, "r");
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error("Choose a regular attachment file.");
    const bytes = Buffer.alloc(TEXT_BYTES + 1);
    let read = 0;
    while (read < bytes.length) {
      checkAbort(signal);
      const next = await handle.read(bytes, read, bytes.length - read, read);
      if (!next.bytesRead) break;
      read += next.bytesRead;
    }
    const byteTruncated = read > TEXT_BYTES;
    const content = bytes.subarray(0, Math.min(read, TEXT_BYTES));
    // Control bytes and strict UTF-8 validation keep arbitrary binary out of model text.
    if (content.some((byte) => byte < 32 && ![9, 10, 12, 13].includes(byte)) || content.includes(127)) {
      throw new Error("This attachment contains binary data. Choose a supported document, image, video, or UTF-8 text file.");
    }
    let decoded: string;
    try {
      decoded = new TextDecoder("utf-8", { fatal: true }).decode(content, { stream: byteTruncated });
    } catch {
      throw new Error("This attachment contains binary data or invalid UTF-8. Save the text as UTF-8 and attach it again.");
    }
    decoded = decoded.replace(/\r\n?/g, "\n");
    const lines: string[] = [];
    let offset = 0;
    let length = 0;
    let textTruncated = false;
    do {
      const next = decoded.indexOf("\n", offset);
      const end = next < 0 ? decoded.length : next;
      const prefix = `${lines.length + 1} | `;
      const remaining = PREPARED_TEXT_CHARACTERS - 256 - length - prefix.length - 1;
      if (remaining <= 0) { textTruncated = true; break; }
      let includedEnd = Math.min(end, offset + remaining);
      if (includedEnd < end && /[\uD800-\uDBFF]/.test(decoded.charAt(includedEnd - 1))) includedEnd--;
      const line = prefix + decoded.slice(offset, includedEnd);
      lines.push(line);
      length += line.length + 1;
      if (includedEnd < end) { textTruncated = true; break; }
      if (next < 0) break;
      offset = next + 1;
    } while (offset <= decoded.length);
    const truncated = byteTruncated || textTruncated;
    const coverage = truncated
      ? `Coverage: prefix through source line ${lines.length}; final line may be partial. Read limit: 2 MiB. Numbered text budget: ${PREPARED_TEXT_CHARACTERS} characters.`
      : `Coverage: complete UTF-8 text, ${read} bytes.`;
    return { text: `${coverage}\n\n${lines.join("\n")}`, images: [], truncated };
  } finally {
    await handle.close();
  }
}

function parsePreparation(raw: string): AttachmentPreparation {
  let value: AttachmentPreparation;
  try { value = JSON.parse(raw) as AttachmentPreparation; }
  catch { throw new Error("The document worker returned invalid JSON."); }
  if (!value || typeof value.text !== "string" || value.text.length > PREPARED_TEXT_CHARACTERS
    || typeof value.truncated !== "boolean" || !Array.isArray(value.images) || value.images.length > 6
    || value.images.some((image) => !image || !safeFileName(image.fileName)
      || !["image/jpeg", "image/png"].includes(image.mediaType) || typeof image.label !== "string" || image.label.length > 1000)
    || (value.previewFile !== undefined && !safeFileName(value.previewFile))
    || (value.durationSeconds !== undefined && (!Number.isFinite(value.durationSeconds) || value.durationSeconds <= 0))) {
    throw new Error("The document worker returned an invalid preparation result.");
  }
  return value;
}

async function prepareVideo(
  input: AttachmentProcessorInput, ffprobe: string, ffmpeg: string, signal?: AbortSignal,
): Promise<AttachmentPreparation> {
  const metadata = await run(ffprobe, [
    "-v", "error", "-threads", "2", "-protocol_whitelist", "file,pipe", "-show_entries",
    "format=duration:stream=index,codec_type,width,height,duration,avg_frame_rate:stream_disposition=attached_pic",
    "-of", "json", input.path,
  ], VIDEO_TIMEOUT, signal);
  let probe: { format?: { duration?: string }; streams?: Array<{
    index?: number; codec_type?: string; width?: number; height?: number; duration?: string; avg_frame_rate?: string;
    disposition?: { attached_pic?: number };
  }> };
  try { probe = JSON.parse(metadata) as typeof probe; }
  catch { throw new Error("FFprobe returned invalid video metadata."); }
  const stream = probe?.streams?.find((item) => item.codec_type === "video" && item.disposition?.attached_pic !== 1
    && Number.isInteger(item.index) && Number(item.index) >= 0 && Number(item.width) > 0 && Number(item.height) > 0);
  if (!stream) throw new Error("This attachment has no visual video stream. Choose a video with visible frames.");
  const streamDuration = Number(stream.duration);
  const duration = streamDuration > 0 && Number.isFinite(streamDuration) ? streamDuration : Number(probe.format?.duration);
  if (!Number.isFinite(duration) || duration <= 0) throw new Error("This video needs a finite positive duration for frame sampling.");
  const images: AttachmentPreparation["images"] = [];
  const [numerator, denominator] = (stream.avg_frame_rate ?? "0/1").split("/").map(Number);
  const frameRate = numerator / denominator;
  const finalFrameTime = Math.max(0, duration - (Number.isFinite(frameRate) && frameRate > 0 ? 1 / frameRate : 0.1));
  // Include the first frame, then sample six intervals while staying within the last frame.
  for (let index = 0; index < 6; index++) {
    checkAbort(signal);
    const timestamp = Math.min(duration * index / 6, finalFrameTime);
    const fileName = `frame-${index + 1}.jpg`;
    await run(ffmpeg, [
      "-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-threads", "2", "-filter_threads", "1",
      "-protocol_whitelist", "file,pipe", "-ss", timestamp.toFixed(6), "-i", input.path,
      "-map", `0:${stream.index}`, "-an", "-sn", "-dn", "-frames:v", "1",
      "-vf", "scale=1280:1280:force_original_aspect_ratio=decrease", "-q:v", "3", "-threads", "2",
      join(input.outputDirectory, fileName),
    ], VIDEO_TIMEOUT, signal);
    const info = await lstat(join(input.outputDirectory, fileName));
    if (!info.isFile() || info.size === 0) throw new Error(`FFmpeg produced an empty frame at ${timestamp.toFixed(3)} seconds.`);
    images.push({ fileName, mediaType: "image/jpeg", label: `Sample ${index + 1} at ${timestamp.toFixed(3)}s (seek target)` });
  }
  return {
    text: `Video duration: ${duration.toFixed(3)} seconds. Coverage: six visual frame samples starting at the first frame; timestamps identify seek targets. Short clips can repeat a frame. Audio coverage: visual sampling only.\n${images.map((image) => image.label).join("\n")}`,
    images, previewFile: images[0].fileName, durationSeconds: duration, truncated: true,
  };
}

export function createAttachmentProcessor(options: {
  runtimeDirectory: string;
  workerPath: string;
  documentProcessor?: AttachmentProcessor;
  normalizeImage?: (path: string, outputDirectory: string) => Promise<AttachmentPreparation>;
  pythonPath?: string;
  ffmpegPath?: string;
  ffprobePath?: string;
}): AttachmentProcessor {
  const documentProcessor = options.documentProcessor
    ?? createDoclingDocumentProcessor(options);
  return async (input, signal) => {
    checkAbort(signal);
    const path = resolve(input.path);
    if (!(await lstat(path)).isFile()) throw new Error("Choose a regular attachment file.");
    const extension = extname(input.name || path).toLowerCase();
    const mediaType = input.mediaType.toLowerCase().split(";", 1)[0].trim();
    const documentFormat = DOCUMENT_EXTENSIONS.has(extension) ? extension : DOCUMENT_TYPES[mediaType];
    const document = Boolean(documentFormat);
    const image = mediaType.startsWith("image/") || IMAGE_EXTENSIONS.has(extension);
    const video = mediaType.startsWith("video/") || VIDEO_EXTENSIONS.has(extension);
    if (!document && !image && !video) return prepareText(path, signal);

    await mkdir(input.outputDirectory, { recursive: true });
    const staging = await mkdtemp(join(resolve(input.outputDirectory), ".attachment-"));
    const published: string[] = [];
    try {
      const stagedInput = { ...input, path, outputDirectory: staging };
      let result: AttachmentPreparation;
      if (document) {
        result = await documentProcessor({ ...stagedInput, documentFormat }, signal);
      } else if (image) {
        if (!options.normalizeImage) throw new Error("The native attachment image normalizer is unavailable.");
        result = await options.normalizeImage(path, staging);
      } else {
        const [ffprobe, ffmpeg] = await Promise.all([
          executable("ffprobe", options.runtimeDirectory, options.ffprobePath ?? process.env.ATTACHMENT_FFPROBE_PATH),
          executable("ffmpeg", options.runtimeDirectory, options.ffmpegPath ?? process.env.ATTACHMENT_FFMPEG_PATH),
        ]);
        result = await prepareVideo(stagedInput, ffprobe, ffmpeg, signal);
      }
      checkAbort(signal);
      // Validate both returned references and every cache artifact before publication.
      result = parsePreparation(JSON.stringify(result));
      const names = await readdir(staging);
      for (const name of names) {
        if (!safeFileName(name) || !(await lstat(join(staging, name))).isFile()) {
          throw new Error("An attachment engine produced an unsafe derivative file.");
        }
      }
      for (const name of [...result.images.map((item) => item.fileName), ...(result.previewFile ? [result.previewFile] : [])]) {
        if (!names.includes(name)) throw new Error(`An attachment derivative is missing: ${name}.`);
      }
      for (const name of names) {
        checkAbort(signal);
        const target = join(input.outputDirectory, name);
        // Exclusive hard links publish files atomically within the same filesystem.
        await link(join(staging, name), target);
        published.push(target);
      }
      checkAbort(signal);
      return result;
    } catch (error) {
      await Promise.all(published.map((path) => rm(path, { force: true })));
      throw error;
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  };
}

export function createDoclingDocumentProcessor(options: {
  runtimeDirectory: string;
  workerPath: string;
  pythonPath?: string;
  documentTimeoutMs?: number;
}): AttachmentProcessor {
  const processor = async (
    input: AttachmentProcessorInput,
    signal?: AbortSignal,
  ): Promise<AttachmentPreparation> => {
    const python = await executable(
      "python3.12",
      options.runtimeDirectory,
      options.pythonPath ?? process.env.ATTACHMENT_PYTHON_PATH,
    );
    try {
      await access(options.workerPath, constants.R_OK);
    } catch {
      throw new Error(`The attachment document worker is unavailable. ${SETUP}`);
    }
    return parsePreparation(await run(python, [
      "-I", resolve(options.workerPath), "--input", input.path,
      "--output-directory", input.outputDirectory,
      "--runtime-directory", resolve(options.runtimeDirectory),
      "--max-pages", "50",
      ...(input.documentFormat ? ["--format", input.documentFormat] : []),
    ], options.documentTimeoutMs ?? DOCUMENT_TIMEOUT, signal, {
      ...process.env,
      HF_HUB_OFFLINE: "1",
      HF_HUB_DISABLE_TELEMETRY: "1",
      TRANSFORMERS_OFFLINE: "1",
      HF_HOME: join(options.runtimeDirectory, "cache", "huggingface"),
      OMP_NUM_THREADS: "2",
      MKL_NUM_THREADS: "2",
      OPENBLAS_NUM_THREADS: "2",
      TOKENIZERS_PARALLELISM: "false",
    }));
  };
  Object.defineProperty(processor, "identity", { value: "docling-2.142.1", enumerable: true });
  return processor as AttachmentProcessor;
}
