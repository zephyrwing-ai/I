import { spawn, type ChildProcess } from "node:child_process";
import { access, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type {
  AttachmentProcessingSettings,
  DocumentParserDescriptor,
} from "../../shared/ipc.js";
import { prepareLightDocument } from "./lightweight-documents.js";
import {
  createDoclingDocumentProcessor,
  type AttachmentProcessor,
  type AttachmentProcessorInput,
  type AttachmentPreparation,
} from "./processors.js";

const SETTINGS_VERSION = 1;
const INSTALL_TIMEOUT_MS = 30 * 60_000;
const MAX_INSTALL_OUTPUT_BYTES = 64 * 1024;

interface StoredSettings {
  version: number;
  documentParserId: string;
}

interface ParserRegistration {
  descriptor: Omit<DocumentParserDescriptor, "available" | "installing" | "canInstall" | "unavailableReason">;
  processor: AttachmentProcessor;
  available(): Promise<{ ready: boolean; reason?: string }>;
}

export interface DocumentParserRegistryOptions {
  settingsPath: string;
  runtimeDirectory: string;
  doclingWorkerPath: string;
  installScriptPath: string;
  pythonPath?: string;
}

/**
 * Parser selection belongs to the attachment domain. Docling is an optional
 * runtime and is never probed or loaded as part of the default parser path.
 */
export class DocumentParserRegistry {
  private activeId = "lightweight";
  private installError: string | undefined;
  private installer: ChildProcess | null = null;
  private installPromise: Promise<void> | null = null;
  private readonly registrations = new Map<string, ParserRegistration>();
  readonly processor: AttachmentProcessor;

  constructor(private readonly options: DocumentParserRegistryOptions) {
    const lightweight = makeProcessor(
      async (input, signal) => prepareLightDocument(input, signal),
      "lightweight-v1",
    );
    this.registrations.set("lightweight", {
      descriptor: {
        parserId: "lightweight",
        displayName: "Built-in",
        version: "1",
        advanced: false,
      },
      processor: lightweight,
      available: async () => ({ ready: true }),
    });
    this.registrations.set("docling", {
      descriptor: {
        parserId: "docling",
        displayName: "Docling",
        version: "2.142.1",
        advanced: true,
      },
      processor: createDoclingDocumentProcessor({
        runtimeDirectory: options.runtimeDirectory,
        workerPath: options.doclingWorkerPath,
        pythonPath: options.pythonPath,
      }),
      available: () => this.doclingAvailability(),
    });

    const registry = this;
    const processor = async (
      input: AttachmentProcessorInput,
      signal?: AbortSignal,
    ): Promise<AttachmentPreparation> => {
      const registration = registry.registrations.get(registry.activeId);
      if (!registration) throw new Error("Choose an available document parser.");
      const availability = await registration.available();
      if (!availability.ready) throw new Error(availability.reason ?? "The document parser is unavailable.");
      return registration.processor(input, signal);
    };
    Object.defineProperty(processor, "identity", {
      enumerable: true,
      get: () => {
        const registration = registry.registrations.get(registry.activeId);
        return registration ? `${registration.descriptor.parserId}@${registration.descriptor.version}` : "none";
      },
    });
    this.processor = processor as AttachmentProcessor;
  }

  async initialize(): Promise<void> {
    try {
      const stored = JSON.parse(await readFile(this.options.settingsPath, "utf8")) as Partial<StoredSettings>;
      const candidate = typeof stored.documentParserId === "string" ? stored.documentParserId : "lightweight";
      if (await this.parserAvailable(candidate)) this.activeId = candidate;
    } catch {
      this.activeId = "lightweight";
    }
  }

  async settings(): Promise<AttachmentProcessingSettings> {
    const parsers: DocumentParserDescriptor[] = [];
    for (const registration of this.registrations.values()) {
      const availability = await registration.available();
      const installing = registration.descriptor.parserId === "docling" && this.installPromise !== null;
      parsers.push({
        ...registration.descriptor,
        available: availability.ready,
        installing,
        canInstall: registration.descriptor.parserId === "docling" && !availability.ready && !installing,
        ...(availability.reason ? { unavailableReason: availability.reason } : {}),
      });
    }
    return { documentParserId: this.activeId, parsers };
  }

  async select(parserId: string): Promise<AttachmentProcessingSettings> {
    const registration = this.registrations.get(parserId);
    if (!registration) throw new Error("Choose a supported document parser.");
    const availability = await registration.available();
    if (!availability.ready) throw new Error(availability.reason ?? "The document parser is unavailable.");
    this.activeId = parserId;
    await this.persist();
    return this.settings();
  }

  async install(parserId: string): Promise<AttachmentProcessingSettings> {
    if (parserId !== "docling") throw new Error("This document parser has no downloadable runtime.");
    if (this.installPromise) {
      await this.installPromise;
      return this.settings();
    }
    if (await this.parserAvailable("docling")) return this.settings();
    this.installError = undefined;
    const installation = this.runInstaller();
    this.installPromise = installation;
    try {
      await installation;
    } finally {
      this.installPromise = null;
      this.installer = null;
    }
    return this.settings();
  }

  async dispose(): Promise<void> {
    if (this.installer && !this.installer.killed) this.installer.kill("SIGTERM");
    await this.installPromise?.catch(() => undefined);
  }

  private async parserAvailable(parserId: string): Promise<boolean> {
    const registration = this.registrations.get(parserId);
    return Boolean(registration && (await registration.available()).ready);
  }

  private async doclingAvailability(): Promise<{ ready: boolean; reason?: string }> {
    if (this.installError) return { ready: false, reason: this.installError };
    const python = join(
      this.options.runtimeDirectory,
      "venv",
      process.platform === "win32" ? "Scripts/python.exe" : "bin/python",
    );
    const models = join(this.options.runtimeDirectory, "models");
    try {
      await access(python);
      await access(this.options.doclingWorkerPath);
      const entries = await readdir(models);
      if (entries.length > 0) return { ready: true };
    } catch {
      // Missing files identify an uninstalled optional runtime.
    }
    return { ready: false, reason: "Download the advanced parser to use it." };
  }

  private async runInstaller(): Promise<void> {
    await mkdir(dirname(this.options.settingsPath), { recursive: true });
    const script = this.options.installScriptPath;
    try {
      await access(script);
    } catch {
      throw new Error("The advanced parser installer is unavailable.");
    }
    await new Promise<void>((resolve, reject) => {
      let stderr = "";
      let settled = false;
      const child = spawn(process.execPath, [script, "--directory", this.options.runtimeDirectory], {
        shell: false,
        detached: process.platform !== "win32",
        stdio: ["ignore", "ignore", "pipe"],
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: "1",
          ATTACHMENT_RUNTIME_DIRECTORY: this.options.runtimeDirectory,
          ATTACHMENT_REQUIREMENTS_PATH: join(dirname(this.options.doclingWorkerPath), "requirements.txt"),
          UV_NO_PROGRESS: "1",
          HF_HUB_DISABLE_TELEMETRY: "1",
        },
      });
      this.installer = child;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) {
          this.installError = error.message;
          reject(error);
        } else {
          this.installError = undefined;
          resolve();
        }
      };
      const timer = setTimeout(() => {
        if (process.platform !== "win32" && child.pid) {
          try { process.kill(-child.pid, "SIGTERM"); } catch { /* Process already exited. */ }
        } else child.kill("SIGTERM");
        finish(new Error("The advanced parser download timed out."));
      }, INSTALL_TIMEOUT_MS);
      child.stderr?.on("data", (chunk: Buffer) => {
        if (stderr.length < MAX_INSTALL_OUTPUT_BYTES) stderr += chunk.toString("utf8");
      });
      child.on("error", (error) => finish(new Error(`The advanced parser download could not start: ${error.message}`)));
      child.on("close", (code) => {
        if (code === 0) finish();
        else finish(new Error(stderr.trim() || `The advanced parser download exited with code ${code ?? "unknown"}.`));
      });
    });
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.options.settingsPath), { recursive: true });
    const temporary = `${this.options.settingsPath}.${process.pid}.${randomUUID()}.tmp`;
    const payload: StoredSettings = { version: SETTINGS_VERSION, documentParserId: this.activeId };
    await writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, this.options.settingsPath);
  }
}

function makeProcessor(
  execute: AttachmentProcessor,
  identity: string,
): AttachmentProcessor {
  Object.defineProperty(execute, "identity", { value: identity, enumerable: true });
  return execute;
}
