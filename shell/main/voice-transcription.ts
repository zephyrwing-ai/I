import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, mkdtemp, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import { availableParallelism, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type {
  VoiceTranscriptionError,
  VoiceTranscriptionRequest,
  VoiceTranscriptionResult,
} from "../shared/ipc.js";
import { VOICE_TRANSCRIPTION_MAX_AUDIO_BYTES } from "../shared/ipc.js";

const TRANSCRIPTION_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_CAPTURED_STDERR_BYTES = 64 * 1024;

interface VoiceEnginePaths {
  executable: string;
  model: string;
}

interface ActiveTranscription {
  requestId: string;
  ownerWebContentsId: number;
  controller: AbortController;
  finished: Promise<void>;
}

interface VoiceTranscriptionServiceOptions {
  resourcesDirectory?: string;
  temporaryDirectory?: string;
  enginePath?: string;
  modelPath?: string | (() => string | null);
}

/**
 * Main owns the native ASR process and its temporary files. Renderer only receives
 * the final text, while audio bytes stay outside React state and conversation history.
 */
export class VoiceTranscriptionService {
  private active: ActiveTranscription | null = null;
  private disposed = false;

  constructor(private readonly options: VoiceTranscriptionServiceOptions = {}) {}

  async transcribe(
    request: VoiceTranscriptionRequest,
    ownerWebContentsId: number,
  ): Promise<VoiceTranscriptionResult> {
    if (!request || typeof request !== "object"
      || typeof request.requestId !== "string"
      || !request.requestId
      || !(request.audio instanceof ArrayBuffer)) {
      return failure("invalid_request", "The voice transcription request is invalid.");
    }
    if (request.audio.byteLength === 0) {
      return failure("invalid_audio", "The recording is empty. Record again and retry.");
    }
    if (request.audio.byteLength > VOICE_TRANSCRIPTION_MAX_AUDIO_BYTES) {
      return failure("invalid_audio", "The recording exceeds the 20 MB limit.");
    }
    if (!isRecordingWav(request.audio)) {
      return failure("invalid_audio", "Record 16 kHz mono PCM audio and retry.");
    }
    // Whisper can hallucinate text for an exactly silent recording. All-zero PCM
    // proves digital silence without rejecting quiet speech by an amplitude cutoff.
    if (!new Int16Array(request.audio, 44).some((sample) => sample !== 0)) {
      return failure("no_speech", "No speech was detected. Record again and retry.");
    }
    if (this.disposed) return failure("cancelled", "Voice transcription is shutting down.");
    if (this.active) {
      return failure("invalid_request", "Another voice transcription is already active. Wait for it to finish.");
    }

    const controller = new AbortController();
    let finish!: () => void;
    const finished = new Promise<void>((resolveFinished) => { finish = resolveFinished; });
    this.active = { requestId: request.requestId, ownerWebContentsId, controller, finished };
    let workingDirectory: string | null = null;
    try {
      const paths = await this.resolveEngine();
      const temporaryRoot = this.options.temporaryDirectory ?? tmpdir();
      await mkdir(temporaryRoot, { recursive: true });
      workingDirectory = await mkdtemp(join(temporaryRoot, "voice-transcription-"));
      const audioPath = join(workingDirectory, "recording.wav");
      const outputBase = join(workingDirectory, "transcript");
      await writeFile(audioPath, Buffer.from(request.audio), { flag: "wx" });
      await runEngine(paths, audioPath, outputBase, controller.signal);

      const outputPath = `${outputBase}.json`;
      let parsed: unknown;
      try {
        parsed = JSON.parse(await readFile(outputPath, "utf8"));
      } catch {
        return failure("transcription_failed", "The speech engine returned unreadable output.");
      }
      controller.signal.throwIfAborted();
      const text = extractTranscript(parsed);
      if (!text) {
        return failure("no_speech", "No speech was detected. Record again and retry.");
      }
      return { ok: true, text };
    } catch (error) {
      if (controller.signal.aborted) {
        return failure("cancelled", "Voice transcription was cancelled.");
      }
      if (error instanceof VoiceEngineError) {
        return failure(error.kind, error.message);
      }
      return failure(
        "transcription_failed",
        error instanceof Error ? error.message : "Voice transcription failed.",
      );
    } finally {
      try {
        if (workingDirectory) await rm(workingDirectory, { recursive: true, force: true });
      } finally {
        this.active = null;
        finish();
      }
    }
  }

  cancel(requestId: string, ownerWebContentsId: number): void {
    if (this.active?.requestId === requestId && this.active.ownerWebContentsId === ownerWebContentsId) {
      this.active.controller.abort();
    }
  }

  cancelOwner(ownerWebContentsId: number): void {
    if (this.active?.ownerWebContentsId === ownerWebContentsId) this.active.controller.abort();
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    const active = this.active;
    active?.controller.abort();
    await active?.finished;
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
    const model = configuredModel
      ?? process.env.YANSU_WHISPER_MODEL
      ?? join(this.options.resourcesDirectory ?? "", "whisper", "ggml-large-v3-turbo-q5_0.bin");

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

function failure(error: VoiceTranscriptionError, message: string): VoiceTranscriptionResult {
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
}): { enginePath: string; modelPath: string } {
  // A renamed development shell can report isPackaged=true while the default
  // Electron loader still loads the application from its source directory.
  const resourcesDirectory = isPackaged && !defaultApp
    ? join(resourcesPath, "resources")
    : resolve(appPath, "resources");
  return {
    enginePath: join(resourcesDirectory, "whisper", "whisper-cli"),
    modelPath: join(resourcesDirectory, "whisper", "ggml-large-v3-turbo-q5_0.bin"),
  };
}

export { VoiceEngineError };
