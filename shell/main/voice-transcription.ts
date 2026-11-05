import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, mkdtemp, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import { availableParallelism, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Converter } from "opencc-js";
import type {
  VoiceTranscriptionError,
  VoiceTranscriptionSegmentRequest,
  VoiceSegmentResult,
} from "../shared/ipc.js";
import { VOICE_TRANSCRIPTION_MAX_AUDIO_BYTES } from "../shared/ipc.js";

const TRANSCRIPTION_TIMEOUT_MS = 2 * 60 * 1000;
const MAX_CAPTURED_STDERR_BYTES = 64 * 1024;
type ChineseTarget = "cn" | "tw" | "hk" | "t";
const chineseConverters = new Map<ChineseTarget, (text: string) => string>();

interface VoiceEnginePaths {
  executable: string;
  model: string;
}

interface QueuedSegment {
  recordingId: string;
  segmentId: number;
  ownerWebContentsId: number;
  audio: ArrayBuffer;
  resolve: (result: VoiceSegmentResult) => void;
}

interface ActiveSegment {
  recordingId: string;
  segmentId: number;
  ownerWebContentsId: number;
  controller: AbortController;
  finished: Promise<void>;
}

interface VoiceTranscriptionServiceOptions {
  resourcesDirectory?: string;
  temporaryDirectory?: string;
  enginePath?: string;
  modelPath?: string | (() => string | null);
  locale?: () => string;
}

/**
 * Main owns the native ASR process and its temporary files. Segments from one
 * recording share a FIFO queue so only one whisper-cli process runs at a time.
 */
export class VoiceTranscriptionService {
  private active: ActiveSegment | null = null;
  private readonly queue: QueuedSegment[] = [];
  private disposed = false;

  constructor(private readonly options: VoiceTranscriptionServiceOptions = {}) {}

  transcribeSegment(
    request: VoiceTranscriptionSegmentRequest,
    ownerWebContentsId: number,
  ): Promise<VoiceSegmentResult> {
    if (!request || typeof request !== "object"
      || typeof request.recordingId !== "string"
      || !request.recordingId
      || typeof request.segmentId !== "number"
      || !Number.isInteger(request.segmentId)
      || request.segmentId < 0
      || !(request.audio instanceof ArrayBuffer)) {
      return Promise.resolve(failure("invalid_request", "The voice transcription request is invalid."));
    }
    if (request.audio.byteLength === 0) {
      return Promise.resolve(failure("invalid_audio", "The recording is empty. Record again and retry."));
    }
    if (request.audio.byteLength > VOICE_TRANSCRIPTION_MAX_AUDIO_BYTES) {
      return Promise.resolve(failure("invalid_audio", "The recording exceeds the 20 MB limit."));
    }
    if (!isRecordingWav(request.audio)) {
      return Promise.resolve(failure("invalid_audio", "Record 16 kHz mono PCM audio and retry."));
    }
    // Whisper can hallucinate text for an exactly silent recording. All-zero PCM
    // proves digital silence without rejecting quiet speech by an amplitude cutoff.
    if (!new Int16Array(request.audio, 44).some((sample) => sample !== 0)) {
      return Promise.resolve(failure("no_speech", "No speech was detected. Record again and retry."));
    }
    if (this.disposed) {
      return Promise.resolve(failure("cancelled", "Voice transcription is shutting down."));
    }
    const duplicate = (this.active?.recordingId === request.recordingId
        && this.active.segmentId === request.segmentId)
      || this.queue.some((segment) => (
        segment.recordingId === request.recordingId && segment.segmentId === request.segmentId
      ));
    if (duplicate) {
      return Promise.resolve(failure("invalid_request", "The voice transcription segment is already queued."));
    }

    return new Promise<VoiceSegmentResult>((resolve) => {
      this.queue.push({
        recordingId: request.recordingId,
        segmentId: request.segmentId,
        ownerWebContentsId,
        audio: request.audio,
        resolve,
      });
      void this.drain();
    });
  }

  cancel(recordingId: string, ownerWebContentsId: number): void {
    this.dropQueued((segment) => (
      segment.recordingId === recordingId && segment.ownerWebContentsId === ownerWebContentsId
    ));
    if (this.active?.recordingId === recordingId
      && this.active.ownerWebContentsId === ownerWebContentsId) {
      this.active.controller.abort();
    }
  }

  cancelOwner(ownerWebContentsId: number): void {
    this.dropQueued((segment) => segment.ownerWebContentsId === ownerWebContentsId);
    if (this.active?.ownerWebContentsId === ownerWebContentsId) {
      this.active.controller.abort();
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.dropQueued(() => true);
    const active = this.active;
    active?.controller.abort();
    await active?.finished;
  }

  private dropQueued(matches: (segment: QueuedSegment) => boolean): void {
    for (let index = this.queue.length - 1; index >= 0; index -= 1) {
      const segment = this.queue[index];
      if (!matches(segment)) continue;
      this.queue.splice(index, 1);
      segment.resolve(failure("cancelled", "Voice transcription was cancelled."));
    }
  }

  private async drain(): Promise<void> {
    if (this.active || this.disposed) return;
    const segment = this.queue.shift();
    if (!segment) return;
    const controller = new AbortController();
    let finish!: () => void;
    const finished = new Promise<void>((resolveFinished) => { finish = resolveFinished; });
    this.active = {
      recordingId: segment.recordingId,
      segmentId: segment.segmentId,
      ownerWebContentsId: segment.ownerWebContentsId,
      controller,
      finished,
    };
    try {
      segment.resolve(await this.transcribeOne(segment.audio, controller.signal));
    } catch (error) {
      segment.resolve(controller.signal.aborted
        ? failure("cancelled", "Voice transcription was cancelled.")
        : error instanceof VoiceEngineError
          ? failure(error.kind, error.message)
          : failure(
            "transcription_failed",
            error instanceof Error ? error.message : "Voice transcription failed.",
          ));
    } finally {
      this.active = null;
      finish();
      void this.drain();
    }
  }

  private async transcribeOne(audio: ArrayBuffer, signal: AbortSignal): Promise<VoiceSegmentResult> {
    const paths = await this.resolveEngine();
    const temporaryRoot = this.options.temporaryDirectory ?? tmpdir();
    await mkdir(temporaryRoot, { recursive: true });
    const workingDirectory = await mkdtemp(join(temporaryRoot, "voice-transcription-"));
    try {
      const audioPath = join(workingDirectory, "recording.wav");
      const outputBase = join(workingDirectory, "transcript");
      await writeFile(audioPath, Buffer.from(audio), { flag: "wx" });
      await runEngine(paths, audioPath, outputBase, signal);
      let parsed: unknown;
      try {
        parsed = JSON.parse(await readFile(`${outputBase}.json`, "utf8"));
      } catch {
        return failure("transcription_failed", "The speech engine returned unreadable output.");
      }
      signal.throwIfAborted();
      const text = normalizeTranscript(parsed, this.options.locale?.());
      if (!text) return failure("no_speech", "No speech was detected. Record again and retry.");
      return { ok: true, text };
    } catch (error) {
      if (signal.aborted) return failure("cancelled", "Voice transcription was cancelled.");
      if (error instanceof VoiceEngineError) return failure(error.kind, error.message);
      return failure(
        "transcription_failed",
        error instanceof Error ? error.message : "Voice transcription failed.",
      );
    } finally {
      await rm(workingDirectory, { recursive: true, force: true });
    }
  }

  private async resolveEngine(): Promise<VoiceEnginePaths> {
    const executable = this.options.enginePath
      ?? process.env.YANSU_WHISPER_CLI
      ?? join(this.options.resourcesDirectory ?? "", "whisper", "whisper-cli");
    const configuredModel = this.resolveModelPath();
    if (typeof this.options.modelPath === "function" && !configuredModel) {
      throw new VoiceEngineError(
        "model_missing",
        "Select a voice model in Settings → Voice before recording.",
      );
    }
    const model = configuredModel ?? process.env.YANSU_WHISPER_MODEL ?? "";
    if (!model) {
      throw new VoiceEngineError(
        "model_missing",
        "Select a voice model in Settings → Voice before recording.",
      );
    }

    if (!await accessibleFile(executable, constants.R_OK | constants.X_OK)) {
      throw new VoiceEngineError(
        "engine_missing",
        "The local speech engine is not installed. Install the packaged app resources and retry.",
      );
    }
    if (!await validModelFile(model)) {
      throw new VoiceEngineError(
        "model_missing",
        "The local speech model is missing or invalid. Install the app resources and retry.",
      );
    }
    return { executable, model };
  }

  private resolveModelPath(): string | null {
    if (typeof this.options.modelPath === "function") return this.options.modelPath();
    return this.options.modelPath ?? null;
  }
}

class VoiceEngineError extends Error {
  constructor(
    readonly kind: VoiceTranscriptionError,
    message: string,
  ) {
    super(message);
    this.name = "VoiceEngineError";
  }
}

async function accessibleFile(path: string, mode: number): Promise<boolean> {
  try {
    await access(path, mode);
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function validModelFile(path: string): Promise<boolean> {
  if (!await accessibleFile(path, constants.R_OK)) return false;
  const handle = await open(path, "r");
  try {
    const header = Buffer.alloc(48);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    return bytesRead === header.length && header.readUInt32LE(0) === 0x67676d6c;
  } finally {
    await handle.close();
  }
}

// The renderer emits one canonical WAV format. Check its claimed size and format
// at the IPC boundary before writing any files or starting the native decoder.
function isRecordingWav(audio: ArrayBuffer): boolean {
  if (audio.byteLength <= 44) return false;
  const bytes = Buffer.from(audio);
  const dataBytes = bytes.length - 44;
  return bytes.toString("ascii", 0, 4) === "RIFF"
    && bytes.readUInt32LE(4) === bytes.length - 8
    && bytes.toString("ascii", 8, 12) === "WAVE"
    && bytes.toString("ascii", 12, 16) === "fmt "
    && bytes.readUInt32LE(16) === 16
    && bytes.readUInt16LE(20) === 1
    && bytes.readUInt16LE(22) === 1
    && bytes.readUInt32LE(24) === 16_000
    && bytes.readUInt32LE(28) === 32_000
    && bytes.readUInt16LE(32) === 2
    && bytes.readUInt16LE(34) === 16
    && bytes.toString("ascii", 36, 40) === "data"
    && bytes.readUInt32LE(40) === dataBytes
    && dataBytes % 2 === 0;
}

function runEngine(
  paths: VoiceEnginePaths,
  audioPath: string,
  outputBase: string,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    if (signal.aborted) {
      reject(new VoiceEngineError("cancelled", "Voice transcription was cancelled."));
      return;
    }

    const child = spawn(paths.executable, [
      "-m", paths.model,
      "-f", audioPath,
      "-l", "auto",
      "-nt",
      "-np",
      "-oj",
      "-of", outputBase,
      "-t", String(Math.max(1, Math.min(8, availableParallelism()))),
      "--no-prints",
    ], {
      cwd: dirname(outputBase),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stderr = "";
    let stdout = "";
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let abort: (() => void) | undefined;
    let terminationTimer: ReturnType<typeof setTimeout> | undefined;
    let stoppedError: VoiceEngineError | undefined;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (terminationTimer) clearTimeout(terminationTimer);
      if (abort) signal.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolvePromise();
    };
    const stop = (error: VoiceEngineError): void => {
      if (stoppedError || settled) return;
      stoppedError = error;
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      terminationTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }, 2_000);
      terminationTimer.unref();
    };
    abort = (): void => stop(new VoiceEngineError("cancelled", "Voice transcription was cancelled."));
    timeout = setTimeout(() => {
      stop(new VoiceEngineError("timeout", "Voice transcription timed out. Try a shorter recording."));
    }, TRANSCRIPTION_TIMEOUT_MS);
    signal.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = appendLimited(stdout, chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = appendLimited(stderr, chunk);
    });
    child.once("error", (error) => {
      finish(new VoiceEngineError(
        error.message.includes("ENOENT") ? "engine_missing" : "transcription_failed",
        error.message.includes("ENOENT")
          ? "The local speech engine is not available."
          : `The local speech engine could not start: ${error.message}`,
      ));
    });
    child.once("close", (code, signalName) => {
      if (settled) return;
      if (stoppedError) {
        finish(stoppedError);
        return;
      }
      if (code === 0) {
        finish();
        return;
      }
      const detail = lastLine(stderr) || lastLine(stdout);
      finish(new VoiceEngineError(
        "transcription_failed",
        detail
          ? `Voice transcription failed: ${detail}`
          : `Voice transcription failed (${signalName ?? `exit ${code ?? "unknown"}`}).`,
      ));
    });
  });
}

function appendLimited(current: string, chunk: Buffer): string {
  const next = current + chunk.toString("utf8");
  return next.length > MAX_CAPTURED_STDERR_BYTES
    ? next.slice(-MAX_CAPTURED_STDERR_BYTES)
    : next;
}

function lastLine(value: string): string {
  const lines = value.trim().split(/\r?\n/).filter(Boolean);
  return lines.at(-1)?.trim() ?? "";
}

export function extractTranscript(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const transcription = (payload as { transcription?: unknown }).transcription;
  if (!Array.isArray(transcription)) return "";
  return transcription
    .map((segment) => (
      segment && typeof segment === "object"
        && typeof (segment as { text?: unknown }).text === "string"
        ? (segment as { text: string }).text
        : ""
    ))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Whisper can emit either Chinese script for zh audio regardless of model family.
 * Match the user's system Chinese variant; leave other languages untouched.
 */
export function normalizeTranscript(payload: unknown, locale?: string): string {
  const text = extractTranscript(payload);
  if (!text) return text;
  const language = (payload as { result?: { language?: unknown } } | null)?.result?.language;
  if (typeof language !== "string" || !language.toLowerCase().startsWith("zh")) return text;
  const target = chineseTargetForLocale(locale);
  let convert = chineseConverters.get(target);
  if (!convert) {
    convert = Converter({ from: target === "cn" ? "t" : "cn", to: target });
    chineseConverters.set(target, convert);
  }
  return convert(text);
}

function chineseTargetForLocale(locale?: string): ChineseTarget {
  const normalized = (locale ?? "").toLowerCase().replace(/_/g, "-");
  if (normalized.includes("zh-hant") || normalized.includes("zh-tw")
    || normalized.includes("zh-hk") || normalized.includes("zh-mo")) {
    if (normalized.includes("zh-hk") || normalized.includes("zh-mo")) return "hk";
    if (normalized.includes("zh-tw")) return "tw";
    return "t";
  }
  return "cn";
}

function failure(error: VoiceTranscriptionError, message: string): VoiceSegmentResult {
  return { ok: false, error, message };
}

export function voiceResourcePaths({
  isPackaged,
  defaultApp = false,
  resourcesPath,
  appPath,
}: {
  isPackaged: boolean;
  defaultApp?: boolean;
  resourcesPath: string;
  appPath: string;
}): { enginePath: string } {
  // A renamed development shell can report isPackaged=true while the default
  // Electron loader still loads the application from its source directory.
  const resourcesDirectory = isPackaged && !defaultApp
    ? join(resourcesPath, "resources")
    : resolve(appPath, "resources");
  return {
    enginePath: join(resourcesDirectory, "whisper", "whisper-cli"),
  };
}

export { VoiceEngineError };
