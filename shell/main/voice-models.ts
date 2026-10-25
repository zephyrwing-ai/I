import { createHash } from "node:crypto";
import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  VoiceModelActionResult,
  VoiceModelEvent,
  VoiceModelStatus,
  VoiceModelSummary,
} from "../shared/ipc.js";

const HUGGINGFACE_RESOLVE_BASE = "https://huggingface.co";
const PROGRESS_INTERVAL_MS = 200;

interface VoiceModelManifestEntry {
  id: string;
  name: string;
  tag: string;
  repoId: string;
  fileName: string;
  sizeLabel: string;
  ramLabel: string;
  speedLevel: number;
  wer: string;
  recommended: boolean;
  sha256: string;
}

/**
 * whisper.cpp GGML models hosted on the official Hugging Face repository.
 * Small models use q8_0 for quality; large models use q5_0 to bound download size.
 * SHA-256 values are the X-Linked-Etag content hashes served by Hugging Face.
 */
export const VOICE_MODEL_MANIFEST: readonly VoiceModelManifestEntry[] = [
  {
    id: "whisper-large-v3-turbo",
    name: "Whisper large-v3-turbo",
    tag: "GGML q5_0",
    repoId: "ggerganov/whisper.cpp",
    fileName: "ggml-large-v3-turbo-q5_0.bin",
    sizeLabel: "574 MB",
    ramLabel: "1.5 GB",
    speedLevel: 3,
    wer: "8.9%",
    recommended: true,
    sha256: "394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2",
  },
  {
    id: "whisper-large-v3",
    name: "Whisper large-v3",
    tag: "GGML q5_0",
    repoId: "ggerganov/whisper.cpp",
    fileName: "ggml-large-v3-q5_0.bin",
    sizeLabel: "1.1 GB",
    ramLabel: "2.1 GB",
    speedLevel: 1,
    wer: "8.1%",
    recommended: false,
    sha256: "d75795ecff3f83b5faa89d1900604ad8c780abd5739fae406de19f23ecd98ad1",
  },
  {
    id: "whisper-medium",
    name: "Whisper medium",
    tag: "GGML q5_0",
    repoId: "ggerganov/whisper.cpp",
    fileName: "ggml-medium-q5_0.bin",
    sizeLabel: "539 MB",
    ramLabel: "1.5 GB",
    speedLevel: 3,
    wer: "11.2%",
    recommended: false,
    sha256: "19fea4b380c3a618ec4723c3eef2eb785ffba0d0538cf43f8f235e7b3b34220f",
  },
  {
    id: "whisper-small",
    name: "Whisper small",
    tag: "GGML q8_0",
    repoId: "ggerganov/whisper.cpp",
    fileName: "ggml-small-q8_0.bin",
    sizeLabel: "265 MB",
    ramLabel: "1.2 GB",
    speedLevel: 4,
    wer: "15.4%",
    recommended: false,
    sha256: "49c8fb02b65e6049d5fa6c04f81f53b867b5ec9540406812c643f177317f779f",
  },
  {
    id: "whisper-base",
    name: "Whisper base",
    tag: "GGML q8_0",
    repoId: "ggerganov/whisper.cpp",
    fileName: "ggml-base-q8_0.bin",
    sizeLabel: "82 MB",
    ramLabel: "1 GB",
    speedLevel: 5,
    wer: "22.6%",
    recommended: false,
    sha256: "c577b9a86e7e048a0b7eada054f4dd79a56bbfa911fbdacf900ac5b567cbb7d9",
  },
  {
    id: "whisper-tiny",
    name: "Whisper tiny",
    tag: "GGML q8_0",
    repoId: "ggerganov/whisper.cpp",
    fileName: "ggml-tiny-q8_0.bin",
    sizeLabel: "44 MB",
    ramLabel: "1 GB",
    speedLevel: 5,
    wer: "30.1%",
    recommended: false,
    sha256: "c2085835d3f50733e2ff6e4b41ae8a2b8d8110461e18821b09a15c40c42d1cca",
  },
];

interface InstalledModelRecord {
  sha256: string;
  bytes: number;
}

interface VoiceModelState {
  selectedId: string | null;
  installed: Record<string, InstalledModelRecord>;
}

export interface VoiceModelFetchBody {
  getReader(): { read(): Promise<{ done: boolean; value?: Uint8Array }> };
}

export interface VoiceModelFetchResponse {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  body: VoiceModelFetchBody | null;
}

export type VoiceModelFetch = (
  url: string,
  init?: { signal?: AbortSignal; redirect?: string; headers?: Record<string, string> },
) => Promise<VoiceModelFetchResponse>;

export interface VoiceModelServiceOptions {
  modelsDirectory: string;
  statePath: string;
  fetchImpl?: VoiceModelFetch;
  sendEvent: (event: VoiceModelEvent) => void;
}

export class VoiceModelService {
  private readonly installed = new Map<string, InstalledModelRecord>();
  private readonly active = new Map<string, AbortController>();
  private readonly activeProgress = new Map<string, number>();
  private selectedId: string | null = null;
  private stateLoaded = false;

  constructor(private readonly options: VoiceModelServiceOptions) {}

  async load(): Promise<void> {
    if (this.stateLoaded) return;
    try {
      const state = JSON.parse(await readFile(this.options.statePath, "utf8")) as VoiceModelState;
      for (const [id, record] of Object.entries(state.installed ?? {})) {
        if (this.entry(id)) this.installed.set(id, record);
      }
      this.selectedId = this.entry(state.selectedId ?? "") ? state.selectedId : null;
    } catch {
      // First launch or a damaged state file starts from the bundled model.
    }
    this.stateLoaded = true;
  }

  list(): VoiceModelSummary[] {
    return VOICE_MODEL_MANIFEST.map((entry) => ({
      id: entry.id,
      name: entry.name,
      tag: entry.tag,
      sizeLabel: entry.sizeLabel,
      ramLabel: entry.ramLabel,
      speedLevel: entry.speedLevel,
      wer: entry.wer,
      recommended: entry.recommended,
      status: this.statusOf(entry.id),
      progress: this.activeProgress.get(entry.id) ?? null,
      selected: this.selectedId === entry.id,
    }));
  }

  async download(modelId: string): Promise<VoiceModelActionResult> {
    const entry = this.entry(modelId);
    if (!entry) return { ok: false, error: "The voice model is not offered in this app." };
    if (this.active.has(modelId)) return { ok: false, error: "The voice model download is already active." };

    const controller = new AbortController();
    this.active.set(modelId, controller);
    this.activeProgress.set(modelId, 0);
    this.emit(modelId, "downloading", 0);
    let partPath: string | null = null;
    let handle: Awaited<ReturnType<typeof open>> | null = null;
    try {
      await mkdir(this.options.modelsDirectory, { recursive: true });
      const fetchImpl = this.options.fetchImpl
        ?? ((input: string, init?: RequestInit) => fetch(input, init));
      const targetPath = join(this.options.modelsDirectory, entry.fileName);
      partPath = `${targetPath}.part`;
      const url = `${HUGGINGFACE_RESOLVE_BASE}/${entry.repoId}/resolve/main/${entry.fileName}`;
      const response = await fetchImpl(url, {
        signal: controller.signal,
        redirect: "follow",
        headers: { "User-Agent": "agent-studio" },
      });
      if (!response.ok) {
        throw new Error(`The model download failed with HTTP ${response.status}.`);
      }
      if (!response.body) {
        throw new Error("The model download returned no content.");
      }

      const total = Number(response.headers.get("content-length") ?? 0);
      const hash = createHash("sha256");
      const reader = response.body.getReader();
      handle = await open(partPath, "w");
      let received = 0;
      let lastEmit = 0;
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done || !chunk.value) break;
        hash.update(chunk.value);
        await handle.write(chunk.value);
        received += chunk.value.byteLength;
        const now = Date.now();
        if (now - lastEmit >= PROGRESS_INTERVAL_MS) {
          lastEmit = now;
          this.activeProgress.set(modelId, total > 0 ? Math.min(99, Math.round(received / total * 100)) : 0);
          this.emit(modelId, "downloading", this.activeProgress.get(modelId)!);
        }
      }
      await handle.close();
      handle = null;
      if (total > 0 && received !== total) {
        throw new Error("The model download ended before it was complete.");
      }
      if (hash.digest("hex") !== entry.sha256) {
        await rm(partPath, { force: true });
        throw new Error("The downloaded model failed its integrity check.");
      }
      await rename(partPath, targetPath);
      partPath = null;
      this.installed.set(modelId, { sha256: entry.sha256, bytes: received });
      await this.persist();
      this.activeProgress.delete(modelId);
      this.emit(modelId, "installed", null);
      return { ok: true };
    } catch (error) {
      await handle?.close().catch(() => undefined);
      if (partPath) await rm(partPath, { force: true }).catch(() => undefined);
      const message = controller.signal.aborted
        ? "The model download was cancelled."
        : error instanceof Error ? error.message : "The model download failed.";
      this.activeProgress.delete(modelId);
      this.emit(modelId, "not_downloaded", null);
      return { ok: false, error: message };
    } finally {
      this.active.delete(modelId);
    }
  }

  cancel(modelId: string): void {
    this.active.get(modelId)?.abort();
  }

  async select(modelId: string): Promise<VoiceModelActionResult> {
    if (!this.installed.has(modelId)) {
      return { ok: false, error: "Install the voice model before selecting it." };
    }
    this.selectedId = modelId;
    await this.persist();
    return { ok: true };
  }

  currentModelPath(): string | null {
    if (!this.selectedId) return null;
    const entry = this.entry(this.selectedId);
    if (!entry || !this.installed.has(this.selectedId)) return null;
    return join(this.options.modelsDirectory, entry.fileName);
  }

  dispose(): void {
    for (const controller of this.active.values()) controller.abort();
    this.active.clear();
  }

  private statusOf(modelId: string): VoiceModelStatus {
    if (this.active.has(modelId)) return "downloading";
    if (this.installed.has(modelId)) return "installed";
    return "not_downloaded";
  }

  private emit(modelId: string, status: VoiceModelStatus, progress: number | null): void {
    this.options.sendEvent({ modelId, status, progress });
  }

  private async persist(): Promise<void> {
    const state: VoiceModelState = {
      selectedId: this.selectedId,
      installed: Object.fromEntries(this.installed),
    };
    await writeFile(this.options.statePath, JSON.stringify(state), "utf8");
  }

  private entry(modelId: string | null): VoiceModelManifestEntry | undefined {
    return VOICE_MODEL_MANIFEST.find((candidate) => candidate.id === modelId);
  }
}
