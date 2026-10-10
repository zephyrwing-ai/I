import { app, Menu, safeStorage, BrowserWindow, dialog, webContents, ipcMain, shell } from "electron";
import { mkdtempSync, writeFileSync, constants, mkdirSync } from "node:fs";
import { resolve, basename, relative, sep, extname, dirname, join as join$1, isAbsolute, parse } from "node:path";
import { randomUUID, createHash, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { join } from "path";
import fs, { realpath, stat, readFile, open, mkdir, writeFile, rename, opendir, lstat, readdir, rm } from "node:fs/promises";
import childProcess, { spawn, fork } from "node:child_process";
import { tmpdir } from "node:os";
import { isUtf8, Buffer as Buffer$1 } from "node:buffer";
import { rgPath } from "@vscode/ripgrep";
import { M as MAX_CLI_BYTES, b as isCliRequest, i as isCliReply } from "./protocol-BcvILXCM.js";
import { DatabaseSync } from "node:sqlite";
const appIconPath = join(import.meta.dirname, "./chunks/app-icon-BW5706cq.png");
const name = "agent-studio";
const productName$1 = "I";
const applicationMetadata = {
  name,
  productName: productName$1
};
const IPC = {
  run: "agent:run",
  steer: "agent:steer",
  stop: "agent:stop",
  event: "agent:event",
  loadHistoryPage: "history:load-page",
  getActiveProject: "projects:active",
  selectProject: "projects:select",
  clearProject: "projects:clear",
  listProviderProfiles: "providers:list",
  discoverProviderModels: "providers:discover-models",
  cancelProviderModelDiscovery: "providers:cancel-discovery",
  refreshProviderModels: "providers:refresh-models",
  saveProvider: "providers:save",
  deleteProvider: "providers:delete",
  selectAttachments: "attachments:select",
  loadCanvasDocument: "canvas:load-document",
  saveCanvasDocument: "canvas:save-document",
  prepareCanvasContext: "canvas:prepare-context",
  canvasEditRequest: "canvas:edit-request",
  canvasEditCancel: "canvas:edit-cancel",
  canvasEditResult: "canvas:edit-result",
  previewOutputFile: "output-files:preview",
  openOutputFile: "output-files:open"
};
const MAX_TEXT_BYTES = 512 * 1024;
const MAX_IMAGE_BYTES$1 = 5 * 1024 * 1024;
const IMAGE_MEDIA_TYPES = /* @__PURE__ */ new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
class OutputFileRegistry {
  runs = /* @__PURE__ */ new Map();
  register(runId, cwd, artifacts) {
    let files = this.runs.get(runId);
    if (!files) {
      files = /* @__PURE__ */ new Map();
      this.runs.set(runId, files);
      while (this.runs.size > 12) this.runs.delete(this.runs.keys().next().value);
    }
    const byPath = new Map([...files.values()].map((record2) => [record2.path, record2]));
    const descriptors = [];
    for (const artifact2 of artifacts) {
      const normalizedPath = resolve(artifact2.path);
      const existing = byPath.get(normalizedPath);
      if (artifact2.operation === "updated" && !existing) continue;
      const fileId = existing?.descriptor.fileId ?? randomUUID();
      const descriptor = {
        runId,
        fileId,
        name: basename(normalizedPath),
        displayPath: displayPath$1(cwd, normalizedPath),
        operation: existing ? "updated" : "created",
        mediaType: artifact2.mediaType,
        byteSize: artifact2.byteSize,
        updatedAt: artifact2.updatedAt
      };
      const record2 = { descriptor, path: normalizedPath };
      files.set(fileId, record2);
      byPath.set(normalizedPath, record2);
      descriptors.push(descriptor);
    }
    return descriptors;
  }
  async preview(runId, fileId) {
    const record2 = this.get(runId, fileId);
    if (!record2) return failure$1("not_found", "The output file does not exist or is no longer valid.");
    const verified = await verifyRecord(record2);
    if (!verified.ok) return failure$1("not_found", verified.message);
    const fileStats = verified.stats;
    const updatedAt = fileStats.mtime.toISOString();
    const byteSize = Number(fileStats.size);
    if (IMAGE_MEDIA_TYPES.has(record2.descriptor.mediaType)) {
      if (byteSize > MAX_IMAGE_BYTES$1) return failure$1("too_large", "The image exceeds 5 MB and cannot be previewed inline.", record2.descriptor.mediaType, byteSize);
      try {
        const content = await readFile(record2.path);
        return {
          ok: true,
          kind: "image",
          mediaType: record2.descriptor.mediaType,
          dataUrl: `data:${record2.descriptor.mediaType};base64,${content.toString("base64")}`,
          byteSize,
          updatedAt
        };
      } catch {
        return failure$1("read_failed", "Failed to read the image.", record2.descriptor.mediaType, byteSize);
      }
    }
    if (!isTextMediaType(record2.descriptor.mediaType)) {
      return {
        ok: true,
        kind: "unsupported",
        mediaType: record2.descriptor.mediaType,
        byteSize,
        updatedAt
      };
    }
    try {
      const size = Math.min(byteSize, MAX_TEXT_BYTES);
      const handle = await open(record2.path, "r");
      try {
        const buffer = Buffer.alloc(size);
        const { bytesRead } = await handle.read(buffer, 0, size, 0);
        return {
          ok: true,
          kind: "text",
          mediaType: record2.descriptor.mediaType,
          content: buffer.subarray(0, bytesRead).toString("utf8"),
          truncated: byteSize > MAX_TEXT_BYTES,
          byteSize,
          updatedAt
        };
      } finally {
        await handle.close();
      }
    } catch {
      return failure$1("read_failed", "Failed to read the file.", record2.descriptor.mediaType, byteSize);
    }
  }
  resolveForOpen(runId, fileId) {
    return this.get(runId, fileId);
  }
  get(runId, fileId) {
    return this.runs.get(runId)?.get(fileId);
  }
}
async function validateOutputForOpen(record2) {
  try {
    const canonical = await realpath(record2.path);
    if (canonical !== record2.path) return { ok: false, error: "The output file path has changed." };
    const fileStats = await stat(canonical);
    if (!fileStats.isFile()) return { ok: false, error: "The output target is no longer a file." };
    return { ok: true, path: canonical };
  } catch {
    return { ok: false, error: "The output file does not exist or cannot be accessed." };
  }
}
function displayPath$1(cwd, path) {
  const relativePath = relative(resolve(cwd), path);
  if (relativePath && relativePath !== ".." && !relativePath.startsWith(`..${sep}`)) return relativePath;
  return path;
}
async function verifyRecord(record2) {
  try {
    const canonical = await realpath(record2.path);
    if (canonical !== record2.path) return { ok: false, message: "The output file path has changed." };
    const stats = await stat(canonical);
    if (!stats.isFile()) return { ok: false, message: "The output target is no longer a file." };
    return { ok: true, stats };
  } catch {
    return { ok: false, message: "The output file does not exist or cannot be accessed." };
  }
}
function isTextMediaType(mediaType) {
  return mediaType.startsWith("text/") || mediaType === "application/json" || mediaType === "application/xml" || mediaType === "application/yaml";
}
function failure$1(error, message, mediaType, byteSize) {
  return { ok: false, error, message, mediaType, byteSize };
}
const MAX_ATTACHMENTS = 100;
class InputAttachmentRegistry {
  records = /* @__PURE__ */ new Map();
  async register(paths) {
    const descriptors = [];
    for (const candidate of paths) {
      try {
        const path = await realpath(candidate);
        const fileStats = await stat(path);
        if (!fileStats.isFile()) continue;
        const attachmentId = randomUUID();
        const descriptor = {
          attachmentId,
          name: basename(path),
          mediaType: mediaTypeForPath$1(path),
          byteSize: Number(fileStats.size)
        };
        this.records.set(attachmentId, { descriptor, path });
        descriptors.push(descriptor);
        while (this.records.size > MAX_ATTACHMENTS) {
          const oldest = this.records.keys().next().value;
          if (!oldest) break;
          this.records.delete(oldest);
        }
      } catch {
      }
    }
    return descriptors;
  }
  async resolve(attachmentIds) {
    const uniqueIds = [...new Set(attachmentIds)];
    const attachments = [];
    for (const attachmentId of uniqueIds) {
      const record2 = this.records.get(attachmentId);
      if (!record2) throw new Error("The attachment does not exist or is no longer valid. Upload it again.");
      try {
        const path = await realpath(record2.path);
        const fileStats = await stat(path);
        if (path !== record2.path || !fileStats.isFile()) throw new Error();
        attachments.push({ ...record2.descriptor, path });
      } catch {
        throw new Error(`The attachment “${record2.descriptor.name}” does not exist or cannot be accessed. Upload it again.`);
      }
    }
    return attachments;
  }
}
function composeTaskWithAttachments(task, attachments) {
  if (attachments.length === 0) return task;
  const list = attachments.map((attachment) => `- ${attachment.name} (attachmentId: ${attachment.attachmentId}): ${JSON.stringify(attachment.path)}`).join("\n");
  return `${task}

The user attached the following local files. Use the available tools to read them only when relevant to the task. Image attachments can also be inserted into the current Canvas with canvas_edit by referencing their attachmentId:
${list}`;
}
function mediaTypeForPath$1(path) {
  switch (extname(path).toLowerCase()) {
    case ".svg":
      return "image/svg+xml";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".bmp":
      return "image/bmp";
    case ".ico":
      return "image/x-icon";
    case ".avif":
      return "image/avif";
    case ".jfif":
      return "image/jfif";
    case ".md":
      return "text/markdown";
    case ".json":
      return "application/json";
    case ".txt":
      return "text/plain";
    case ".pdf":
      return "application/pdf";
    default:
      return "application/octet-stream";
  }
}
function haveSameProviderOrigin(left, right) {
  const leftOrigin = providerOrigin(left);
  return leftOrigin !== null && leftOrigin === providerOrigin(right);
}
function providerOrigin(baseURL) {
  try {
    const url = new URL(baseURL.trim());
    return url.protocol === "http:" || url.protocol === "https:" ? url.origin : null;
  } catch {
    return null;
  }
}
class ProviderDiscoveryError extends Error {
  constructor(kind, message, options) {
    super(message, options);
    this.kind = kind;
    this.name = "ProviderDiscoveryError";
  }
  kind;
}
function inferProviderFromBaseURL(_baseURL) {
  return "openai";
}
function endsWithVersionSegment(pathname) {
  return /\/v\d+(?:beta\d*)?$/.test(pathname);
}
function joinURL(base, path) {
  const copy = new URL(base);
  const basePath = base.pathname.replace(/\/+$/, "");
  copy.pathname = `${basePath}/${path}`.replace(/\/{2,}/g, "/");
  return copy.toString();
}
function buildModelEndpointProbes(baseURL, provider) {
  const probes = [];
  const push = (url) => {
    if (probes.some((probe) => probe.url === url)) return;
    probes.push({ url, dialect: "openai", auth: "bearer" });
  };
  const base = new URL(baseURL.trim().replace(/\/+$/, ""));
  if (endsWithVersionSegment(base.pathname)) {
    push(joinURL(base, "models"));
    if (!base.pathname.endsWith("/v1")) push(joinURL(base, "v1/models"));
  } else {
    push(joinURL(base, "v1/models"));
    push(joinURL(base, "models"));
  }
  return probes;
}
async function discoverProviderModels(connection, options = {}) {
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? 12e3;
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const cancel = () => controller.abort();
  if (options.signal?.aborted) controller.abort();
  options.signal?.addEventListener("abort", cancel, { once: true });
  try {
    const probes = buildModelEndpointProbes(connection.baseURL, connection.provider);
    const models = [];
    let lastError;
    for (const probe of probes) {
      if (controller.signal.aborted) break;
      try {
        models.push(...await fetchModelPage(probe, connection.apiKey, options.fetchImpl ?? fetch, controller.signal));
        break;
      } catch (error) {
        if (error instanceof ProviderDiscoveryError && error.kind === "authentication") throw error;
        lastError = error instanceof ProviderDiscoveryError ? error : new ProviderDiscoveryError("network", "Unable to connect to the service. Check the network and Base URL.", { cause: error });
      }
    }
    if (controller.signal.aborted) {
      throw new ProviderDiscoveryError(
        timedOut ? "timeout" : "cancelled",
        timedOut ? "Connection timed out. Try again." : "Model retrieval was cancelled.",
        { cause: lastError }
      );
    }
    const normalized = normalizeDiscoveredModels(models);
    if (normalized.length === 0) {
      if (lastError) throw lastError;
      throw new ProviderDiscoveryError("empty", "The connection succeeded, but no models were returned.");
    }
    return normalized;
  } catch (error) {
    if (error instanceof ProviderDiscoveryError) throw error;
    throw new ProviderDiscoveryError("network", "Unable to connect to the service. Check the network and Base URL.", { cause: error });
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", cancel);
  }
}
function discoveryErrorResult(error) {
  if (error instanceof ProviderDiscoveryError) {
    return { ok: false, error: error.kind, message: error.message };
  }
  return { ok: false, error: "network", message: error instanceof Error ? error.message : String(error) };
}
function normalizeDiscoveredModels(models) {
  const unique = /* @__PURE__ */ new Map();
  for (const value of models) {
    if (!value || typeof value !== "object") continue;
    const candidate = value;
    const id = typeof candidate.id === "string" ? candidate.id.trim() : "";
    if (!id || unique.has(id)) continue;
    const displayName = typeof candidate.displayName === "string" && candidate.displayName.trim() ? candidate.displayName.trim() : id;
    unique.set(id, { id, displayName });
  }
  return [...unique.values()].sort((left, right) => left.id.localeCompare(right.id));
}
async function fetchModelPage(probe, apiKey, fetchImpl, signal) {
  const models = [];
  let url = probe.url;
  const origin = new URL(url).origin;
  const visited = /* @__PURE__ */ new Set();
  while (true) {
    if (visited.has(url)) throw new ProviderDiscoveryError("invalid_response", "The model list pagination cursor is invalid.");
    visited.add(url);
    const response2 = await fetchImpl(url, {
      method: "GET",
      headers: buildHeaders(probe.auth, apiKey),
      signal
    });
    const failureKind = responseFailureKind(response2);
    if (failureKind !== "ok") throw new ProviderDiscoveryError(failureKind, failureMessage(failureKind, response2.status));
    const payload = await readJson(response2);
    models.push(...parseModelPage(payload));
    const next = nextPageUrl(payload, url, origin);
    if (next === null) break;
    url = next;
  }
  return models;
}
function buildHeaders(auth, apiKey) {
  const headers = { Accept: "application/json" };
  if (auth === "bearer") headers.Authorization = `Bearer ${apiKey}`;
  return headers;
}
function responseFailureKind(response2) {
  if (response2.ok) return "ok";
  if (response2.status === 401 || response2.status === 403) return "authentication";
  if (response2.status === 404 || response2.status === 405 || response2.status === 501) return "unsupported";
  return "network";
}
function failureMessage(kind, status) {
  if (kind === "authentication") return "The API Key is invalid or does not have access.";
  if (kind === "unsupported") return "This service does not support model list discovery.";
  return `The model list request failed with status code ${status}.`;
}
function parseModelPage(payload) {
  if (!payload || typeof payload !== "object") {
    throw new ProviderDiscoveryError("invalid_response", "The model list response format is invalid.");
  }
  const list = payload.data;
  if (!Array.isArray(list)) {
    throw new ProviderDiscoveryError("invalid_response", "The model list response format is invalid.");
  }
  const models = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const record2 = item;
    models.push({
      id: typeof record2.id === "string" ? record2.id : "",
      displayName: firstString(record2.display_name, record2.name, record2.id)
    });
  }
  return models;
}
function nextPageUrl(payload, currentUrl, origin) {
  const body = payload;
  if (typeof body.next === "string" && body.next) {
    const next = new URL(body.next, currentUrl);
    if (next.origin !== origin) throw new ProviderDiscoveryError("invalid_response", "The model list pagination URL is invalid.");
    return next.toString();
  }
  if (body.has_more === true && typeof body.last_id === "string" && body.last_id) {
    const next = new URL(currentUrl);
    next.searchParams.set("after", body.last_id);
    return next.toString();
  }
  return null;
}
async function readJson(response2) {
  try {
    return await response2.json();
  } catch (error) {
    throw new ProviderDiscoveryError("invalid_response", "The model list response format is invalid.", { cause: error });
  }
}
function firstString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}
const STORE_VERSION = 3;
const PROVIDERS = /* @__PURE__ */ new Set(["openai"]);
class ProviderStore {
  constructor(filePath, codec) {
    this.filePath = filePath;
    this.codec = codec;
  }
  filePath;
  codec;
  profiles = [];
  loaded = false;
  loadPromise = null;
  mutation = Promise.resolve();
  async list() {
    await this.ensureLoaded();
    return Promise.all(this.profiles.map((profile) => this.toSummary(profile)));
  }
  async save(input) {
    return this.serialize(async () => {
      await this.ensureLoaded();
      const normalized = normalizeInput(input);
      const existingIndex = normalized.providerProfileId ? this.profiles.findIndex((profile2) => profile2.providerProfileId === normalized.providerProfileId) : -1;
      const existing = existingIndex >= 0 ? this.profiles[existingIndex] : void 0;
      const providerProfileId = existing?.providerProfileId ?? normalized.providerProfileId ?? randomUUID();
      const encryptedApiKey = this.resolveEncryptedSecret(normalized.apiKey, existing, normalized.baseURL);
      const previousModels = new Map(existing?.models.map((model) => [model.modelId, model]) ?? []);
      const profile = {
        providerProfileId,
        provider: inferProviderFromBaseURL(),
        name: normalized.name,
        baseURL: normalized.baseURL,
        encryptedApiKey,
        models: normalized.models.map((model) => {
          const previous = previousModels.get(model.id);
          return {
            modelOptionId: previous?.modelOptionId ?? randomUUID(),
            modelId: model.id,
            displayName: model.displayName,
            available: true,
            imported: true,
            state: "saved"
          };
        })
      };
      const nextProfiles = [...this.profiles];
      if (existingIndex >= 0) nextProfiles[existingIndex] = profile;
      else nextProfiles.push(profile);
      await this.persist(nextProfiles);
      this.profiles = nextProfiles;
      return this.toSummary(profile);
    });
  }
  async delete(providerProfileId) {
    await this.serialize(async () => {
      await this.ensureLoaded();
      const index = this.profiles.findIndex((profile) => profile.providerProfileId === providerProfileId);
      if (index < 0) throw new Error("The provider does not exist or has already been deleted.");
      const nextProfiles = this.profiles.filter((_, profileIndex) => profileIndex !== index);
      await this.persist(nextProfiles);
      this.profiles = nextProfiles;
    });
  }
  async resolve(modelOptionId) {
    await this.ensureLoaded();
    for (const profile of this.profiles) {
      const model = profile.models.find((candidate) => candidate.modelOptionId === modelOptionId && candidate.available);
      if (!model) continue;
      return {
        providerProfileId: profile.providerProfileId,
        modelOptionId,
        provider: profile.provider,
        modelId: model.modelId,
        baseURL: profile.baseURL,
        // Capture the same immutable profile as baseURL, so later edits cannot
        // pair this run's address with another connection's credential.
        getApiKey: async () => this.requireCredential(profile)
      };
    }
    throw new Error("The selected model does not exist or is unavailable. Choose another model.");
  }
  async discoveryConnection(input) {
    await this.ensureLoaded();
    const baseURL = normalizeBaseURL(input.baseURL);
    const existing = input.providerProfileId ? this.profiles.find((profile) => profile.providerProfileId === input.providerProfileId) : void 0;
    if (input.providerProfileId && !existing) throw new Error("The provider does not exist or has already been deleted.");
    let apiKey = input.apiKey?.trim() || "";
    if (!apiKey && existing) {
      this.assertCredentialOrigin(existing, baseURL);
      apiKey = this.requireCredential(existing);
    }
    if (!apiKey) throw new Error("Enter an API Key.");
    return { provider: inferProviderFromBaseURL(), baseURL, apiKey };
  }
  async refreshConnection(providerProfileId) {
    await this.ensureLoaded();
    const profile = this.profiles.find((candidate) => candidate.providerProfileId === providerProfileId);
    if (!profile) throw new Error("The provider does not exist or has already been deleted.");
    return { provider: profile.provider, baseURL: profile.baseURL, apiKey: this.requireCredential(profile) };
  }
  async applyRefresh(providerProfileId, discovered) {
    return this.serialize(async () => {
      await this.ensureLoaded();
      const profileIndex = this.profiles.findIndex((profile2) => profile2.providerProfileId === providerProfileId);
      if (profileIndex < 0) throw new Error("The provider does not exist or has already been deleted.");
      const profile = this.profiles[profileIndex];
      const previous = new Map(profile.models.map((model) => [model.modelId, model]));
      const models = discovered.map((model) => {
        const saved = previous.get(model.id);
        return {
          modelOptionId: saved?.modelOptionId ?? randomUUID(),
          modelId: model.id,
          displayName: model.displayName,
          available: true,
          imported: true,
          state: "saved"
        };
      });
      const refreshed = { ...profile, models };
      const nextProfiles = [...this.profiles];
      nextProfiles[profileIndex] = refreshed;
      await this.persist(nextProfiles);
      this.profiles = nextProfiles;
      return this.toSummary(refreshed);
    });
  }
  async serialize(operation) {
    const previous = this.mutation;
    let release = () => void 0;
    this.mutation = new Promise((resolve2) => {
      release = resolve2;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
  async ensureLoaded() {
    if (this.loaded) return;
    if (!this.loadPromise) this.loadPromise = this.load();
    await this.loadPromise;
  }
  async load() {
    let completed = false;
    try {
      const parsed = JSON.parse(await readFile(this.filePath, "utf8"));
      if ((parsed.version === STORE_VERSION || parsed.version === 2) && Array.isArray(parsed.profiles)) {
        this.profiles = parsed.profiles.filter(isStoredProfile).map(normalizeStoredProfile);
      } else if (parsed.version === 1 && Array.isArray(parsed.profiles)) {
        this.profiles = parsed.profiles.filter(isLegacyStoredProfile).map(migrateLegacyProfile).map(normalizeStoredProfile);
      }
      completed = true;
    } catch (error) {
      const code = error.code;
      if (code !== "ENOENT") throw new Error("Unable to read the provider configuration.", { cause: error });
      completed = true;
    } finally {
      this.loaded = completed;
      this.loadPromise = null;
    }
  }
  async persist(profiles) {
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    const payload = { version: STORE_VERSION, profiles };
    await writeFile(temporaryPath, `${JSON.stringify(payload, null, 2)}
`, { encoding: "utf8", mode: 384 });
    await rename(temporaryPath, this.filePath);
  }
  async toSummary(profile) {
    const credentialConfigured = Boolean(profile.encryptedApiKey);
    const credentialAvailable = credentialConfigured && this.codec.available();
    return {
      providerProfileId: profile.providerProfileId,
      name: profile.name,
      baseURL: profile.baseURL,
      credentialConfigured,
      models: profile.models.map((model) => ({
        modelOptionId: model.modelOptionId,
        providerProfileId: profile.providerProfileId,
        providerName: profile.name,
        modelId: model.modelId,
        displayName: model.displayName,
        available: credentialAvailable && model.available,
        imported: model.imported,
        state: model.state
      }))
    };
  }
  resolveEncryptedSecret(apiKey, existing, baseURL) {
    if (!apiKey) {
      if (!existing?.encryptedApiKey) throw new Error("A provider requires an API Key.");
      this.assertCredentialOrigin(existing, baseURL);
      return existing.encryptedApiKey;
    }
    if (!this.codec.available()) throw new Error("System credential encryption is currently unavailable. The API Key was not saved.");
    return this.codec.encrypt(apiKey);
  }
  assertCredentialOrigin(profile, baseURL) {
    if (!haveSameProviderOrigin(profile.baseURL, baseURL)) {
      throw new Error("Enter an API Key for the new provider address.");
    }
  }
  requireCredential(profile) {
    if (!profile.encryptedApiKey) throw new Error("No API Key is configured for this provider. Open Settings and enter one.");
    return this.decryptSecret(profile);
  }
  decryptSecret(profile) {
    if (!this.codec.available()) throw new Error("System credential decryption is currently unavailable.");
    try {
      const apiKey = this.codec.decrypt(profile.encryptedApiKey ?? "");
      if (!apiKey) throw new Error("empty secret");
      return apiKey;
    } catch (error) {
      throw new Error(`The credentials for provider ${profile.name} could not be decrypted. Configure it again.`, { cause: error });
    }
  }
}
function normalizeInput(input) {
  const name2 = input.name.trim();
  if (!name2) throw new Error("Enter a provider name.");
  const baseURL = normalizeBaseURL(input.baseURL);
  const models = input.models.map((model) => ({
    id: model.id.trim(),
    displayName: model.displayName.trim() || model.id.trim()
  })).filter((model) => model.id);
  if (models.length === 0) throw new Error("Select at least one model.");
  if (new Set(models.map((model) => model.id)).size !== models.length) {
    throw new Error("A provider cannot save duplicate models.");
  }
  return {
    providerProfileId: input.providerProfileId,
    name: name2,
    baseURL,
    apiKey: input.apiKey?.trim() || void 0,
    models
  };
}
function normalizeBaseURL(value) {
  const input = value.trim();
  if (!input) throw new Error("Enter an API Base URL.");
  let url;
  try {
    url = new URL(input);
  } catch {
    throw new Error("The API Base URL is not a valid URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("The API Base URL must use HTTP or HTTPS.");
  }
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}
function isStoredProfile(value) {
  if (!value || typeof value !== "object") return false;
  const profile = value;
  return typeof profile.providerProfileId === "string" && PROVIDERS.has(profile.provider) && typeof profile.name === "string" && typeof profile.baseURL === "string" && Array.isArray(profile.models) && profile.models.every(isStoredModel);
}
function isStoredModel(value) {
  if (!value || typeof value !== "object") return false;
  const model = value;
  return typeof model.modelOptionId === "string" && typeof model.modelId === "string" && typeof model.displayName === "string" && typeof model.available === "boolean" && typeof model.imported === "boolean" && (model.state === "saved" || model.state === "new" || model.state === "unavailable");
}
function normalizeStoredProfile(profile) {
  const models = profile.models.filter((model) => model.available && model.state !== "unavailable").map((model) => ({ ...model, imported: true, state: "saved" }));
  return { ...profile, models };
}
function isLegacyStoredProfile(value) {
  if (!value || typeof value !== "object") return false;
  const profile = value;
  return typeof profile.providerProfileId === "string" && PROVIDERS.has(profile.provider) && typeof profile.displayName === "string" && typeof profile.encryptedApiKey === "string" && Array.isArray(profile.models) && profile.models.every((model) => model && typeof model === "object" && typeof model.modelOptionId === "string" && typeof model.modelId === "string" && typeof model.displayName === "string");
}
function migrateLegacyProfile(profile) {
  return {
    providerProfileId: profile.providerProfileId,
    provider: profile.provider,
    name: profile.displayName,
    baseURL: profile.baseURL || defaultBaseURL(profile.provider),
    encryptedApiKey: profile.encryptedApiKey,
    models: profile.models.map((model) => ({
      ...model,
      available: true,
      imported: true,
      state: "saved"
    }))
  };
}
function defaultBaseURL(_provider) {
  return "https://api.deepseek.com/v1";
}
class RepositoryError extends Error {
  constructor(message, code, options = {}) {
    super(message, options);
    this.code = code;
    this.name = "RepositoryError";
    this.retryable = options.retryable ?? false;
  }
  code;
  retryable;
}
class ToolAttemptBlockedError extends RepositoryError {
  constructor(reason, message) {
    super(message, "conflict", { retryable: false });
    this.reason = reason;
    this.name = "ToolAttemptBlockedError";
  }
  reason;
}
class ModelAdapterError extends Error {
  constructor(kind, message, retryable = false) {
    super(message);
    this.kind = kind;
    this.retryable = retryable;
    this.name = "ModelAdapterError";
  }
  kind;
  retryable;
}
function readModelMessage(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return void 0;
  const message = value;
  if (!["user", "assistant", "tool"].includes(message.role) || typeof message.content !== "string") return void 0;
  for (const field of ["reasoning", "toolCallId", "toolName"]) {
    if (message[field] !== void 0 && typeof message[field] !== "string") return void 0;
  }
  if (message.isError !== void 0 && typeof message.isError !== "boolean") return void 0;
  if (message.toolCalls !== void 0) {
    if (!Array.isArray(message.toolCalls) || !message.toolCalls.every((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return false;
      const call = item;
      return typeof call.id === "string" && typeof call.name === "string" && typeof call.inputComplete === "boolean" && call.input !== null && typeof call.input === "object" && !Array.isArray(call.input);
    })) return void 0;
  }
  if (message.media !== void 0) {
    if (!message.media || typeof message.media !== "object" || Array.isArray(message.media)) return void 0;
    const media = message.media;
    if (typeof media.mediaType !== "string" || typeof media.dataUrl !== "string") return void 0;
  }
  return value;
}
async function* response(config, messages, system, tools, signal) {
  switch (config.provider) {
    case "openai": {
      const { streamOpenAI } = await import("./openai-CUJLlNeC.js");
      yield* streamOpenAI(messages, tools, { model: config.model, ...config.openai }, system, signal);
      return;
    }
  }
}
function canonicalJson(value) {
  const serialized = JSON.stringify(value);
  if (serialized === void 0) throw new TypeError("Value must be JSON serializable.");
  return encodeCanonical(JSON.parse(serialized));
}
function encodeCanonical(value) {
  if (Array.isArray(value)) return `[${value.map(encodeCanonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${encodeCanonical(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
function jsonEqual(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}
function toolInputHash(toolName, toolVersion, input) {
  return toolInputHashFromJson(toolName, toolVersion, canonicalJson(input));
}
function toolInputHashFromJson(toolName, toolVersion, inputJson) {
  return createHash("sha256").update(`${toolName}
${toolVersion}
${inputJson}`, "utf8").digest("hex");
}
function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function artifact(value) {
  return record(value) && typeof value.path === "string" && (value.operation === "created" || value.operation === "updated") && typeof value.mediaType === "string" && typeof value.byteSize === "number" && Number.isSafeInteger(value.byteSize) && value.byteSize >= 0 && typeof value.updatedAt === "string";
}
function readToolResult(value) {
  if (!record(value) || typeof value.ok !== "boolean" || typeof value.output !== "string" || typeof value.returncode !== "number" || !Number.isSafeInteger(value.returncode) || typeof value.truncated !== "boolean" || value.error !== void 0 && typeof value.error !== "string" || value.fullOutputPath !== void 0 && typeof value.fullOutputPath !== "string") return void 0;
  if (value.media !== void 0 && (!record(value.media) || typeof value.media.mediaType !== "string" || typeof value.media.dataUrl !== "string")) return void 0;
  if (value.artifacts !== void 0 && (!Array.isArray(value.artifacts) || !value.artifacts.every(artifact))) return void 0;
  return value;
}
function readToolCheckpoint(value) {
  if (!record(value) || typeof value.version !== "number" || !Number.isSafeInteger(value.version) || value.version < 1 || typeof value.kind !== "string" || !value.kind || !record(value.data)) return void 0;
  return { version: value.version, kind: value.kind, data: value.data };
}
function toolOutcomeStatus(result) {
  return result.error === "cancelled" ? "cancelled" : result.error === "interrupted" ? "interrupted" : result.ok ? "succeeded" : "failed";
}
function toolResultMessage(call, result) {
  const note = result.truncated && result.fullOutputPath ? `
Full output: ${result.fullOutputPath}` : "";
  return {
    role: "tool",
    content: `<returncode>${result.returncode}</returncode>
<output>
${result.output}
</output>${note}`,
    toolCallId: call.id,
    toolName: call.name,
    isError: !result.ok,
    ...result.media ? { media: result.media } : {}
  };
}
const DEFAULT_MODEL_RETRY = {
  maxAttempts: 3,
  baseDelayMs: 1e3,
  maxDelayMs: 8e3
};
const DEFAULT_COMMIT_RETRY = {
  maxAttempts: 3,
  baseDelayMs: 250,
  maxDelayMs: 1e3
};
const DEFAULT_SYSTEM_PROMPT = "You are a coding agent. Use the available tools when needed, then provide a concise final answer.";
async function collectTurn(modelConfig, messages, system, tools, ctx, events, recorder, signal, responseImpl) {
  const aggregated = { content: "", toolCalls: [], stopReason: "unknown" };
  let completed = false;
  for await (const event of responseImpl(modelConfig, messages, system, tools, signal)) {
    switch (event.type) {
      case "reasoning_delta":
        aggregated.reasoning = (aggregated.reasoning ?? "") + event.delta;
        recorder?.recordAssistantDelta("reasoning", event.delta, ctx);
        events.onReasoningDelta?.(event.delta, ctx);
        break;
      case "text_delta":
        aggregated.content += event.delta;
        recorder?.recordAssistantDelta("text", event.delta, ctx);
        events.onAssistantDelta?.(event.delta, ctx);
        break;
      case "completed":
        completed = true;
        aggregated.content = event.content;
        aggregated.reasoning = event.reasoning;
        aggregated.toolCalls = event.toolCalls;
        aggregated.stopReason = event.stopReason;
        aggregated.rawStopReason = event.rawStopReason;
        break;
    }
  }
  return { response: aggregated, completed };
}
async function run(task, modelConfig, config, events = {}) {
  const clock = config.clock ?? Date.now;
  const runStartedAt = clock();
  const startedAt = new Date(runStartedAt).toISOString();
  const messages = [...config.recorder?.snapshot() ?? []];
  const userMessage = { role: "user", content: task };
  const initialUserEntryId = config.initialUserEntryId ?? randomUUID();
  const initialUserCreatedAt = config.initialUserCreatedAt ?? runStartedAt;
  const tools = [...config.tools.values()].map((tool) => tool.definition);
  const retryConfig = { ...DEFAULT_MODEL_RETRY, ...config.modelRetry };
  const commitRetryConfig = { ...DEFAULT_COMMIT_RETRY, ...config.commitRetry };
  let turnOrdinal = 0;
  let currentTurnId;
  let attempt = 0;
  let finished = false;
  let initialUserCommitted = false;
  let readyInputs = [];
  const finish = async (status, error, finalTurnId) => {
    if (finished) return { runId: config.runId, status, error, turnCount: turnOrdinal };
    config.steeringInbox?.stopAdmission();
    let finalStatus = status;
    let finalError = error;
    let unappliedInputIds = [];
    try {
      if (status === "cancelled") {
        await config.cancellationBarrier?.();
        await config.recorder?.requestRunCancellation(config.runId);
        if (!initialUserCommitted && config.recorder) {
          await config.recorder.archiveUnappliedUser(userMessage, { runId: config.runId, entryId: initialUserEntryId, createdAt: initialUserCreatedAt });
          unappliedInputIds.push(initialUserEntryId);
        }
        await recoverOpenToolInvocations(config, config.runId, true);
      }
      await config.recorder?.finishRun({ runId: config.runId, status });
    } catch (finishError) {
      finalStatus = "failed";
      finalError = toAgentError(finishError);
    }
    try {
      const abandoned = await config.steeringInbox?.closeAndAbandon(finalStatus) ?? [];
      unappliedInputIds = [.../* @__PURE__ */ new Set([...unappliedInputIds, ...abandoned])];
    } catch (abandonError) {
      finalStatus = "failed";
      finalError = toAgentError(abandonError);
    }
    if (finalStatus === "completed" && unappliedInputIds.length > 0) {
      finalStatus = "failed";
      finalError = { kind: "runtime", message: "Accepted steering remained unapplied at run completion." };
    }
    let finalDurationMs;
    if (finalStatus === "completed" && finalTurnId) {
      finalDurationMs = Math.max(0, clock() - runStartedAt);
      try {
        await config.recorder?.finalizeAnswerDuration(finalTurnId, finalDurationMs);
      } catch (durationError) {
        finalStatus = "failed";
        finalError = toAgentError(durationError);
      }
    }
    const result = {
      runId: config.runId,
      status: finalStatus,
      error: finalError,
      turnCount: turnOrdinal,
      ...unappliedInputIds.length ? { unappliedInputIds } : {},
      ...finalStatus === "completed" && finalTurnId && finalDurationMs !== void 0 ? { finalTurnId, finalDurationMs } : {}
    };
    finished = true;
    events.onRunCompleted?.(result);
    return result;
  };
  const applyInputs = async (batch) => {
    if (batch.length === 0) return;
    const inputIds = batch.map((input) => input.inputId);
    const entries = config.recorder ? await config.recorder.applyRunInputs(config.runId, inputIds) : batch.map((input) => ({ id: input.inputId, payload: { role: "user", content: input.content } }));
    if (entries.length !== batch.length || entries.some((entry, index) => entry.id !== inputIds[index])) {
      throw new Error("Steering input persistence returned a different input batch.");
    }
    messages.push(...entries.map((entry) => entry.payload));
    events.onInputsApplied?.({ runId: config.runId, inputIds, startedAt: clock() });
  };
  try {
    if (config.signal?.aborted) return finish("cancelled");
    await recoverOpenToolInvocations(config);
    if (config.signal?.aborted) return finish("cancelled");
    if (config.recorder) messages.splice(0, messages.length, ...config.recorder.snapshot());
  } catch (error) {
    return finish("failed", toAgentError(error));
  }
  try {
    await config.recorder?.commitUser(userMessage, { runId: config.runId, entryId: initialUserEntryId, createdAt: initialUserCreatedAt });
    initialUserCommitted = true;
  } catch (error) {
    return finish("failed", toAgentError(error));
  }
  messages.push(...config.runScopedContext ?? [], userMessage);
  events.onRunStart?.({ runId: config.runId, startedAt });
  while (true) {
    if (config.signal?.aborted) return finish("cancelled");
    if (!currentTurnId) {
      try {
        const incoming = config.steeringInbox ? await config.steeringInbox.takePending() : [];
        await applyInputs([...readyInputs, ...incoming]);
        readyInputs = [];
      } catch (error) {
        return finish("failed", toAgentError(error));
      }
      if (config.signal?.aborted) return finish("cancelled");
      currentTurnId = randomUUID();
      turnOrdinal += 1;
      attempt = 0;
    }
    attempt += 1;
    const ctx = { runId: config.runId, turnId: currentTurnId, turnOrdinal, attempt };
    events.onTurnStart?.(ctx);
    let collected;
    let outcome;
    try {
      collected = await collectTurn(modelConfig, messages, config.systemPrompt || DEFAULT_SYSTEM_PROMPT, tools, ctx, events, config.recorder, config.signal, config.responseImpl ?? response);
      if (config.signal?.aborted) outcome = { kind: "cancelled", reason: "aborted" };
      else if (!collected.completed) outcome = { kind: "incomplete", reason: "missing_finish_reason", response: collected.response };
      else outcome = classifyTurn(collected.response);
    } catch (error) {
      if (config.signal?.aborted) outcome = { kind: "cancelled", reason: "aborted" };
      else {
        const agentError = toAgentError(error);
        outcome = {
          kind: "failed",
          reason: agentError.kind === "network" ? "network_error" : agentError.kind === "model_protocol" ? "model_protocol" : "provider_error",
          error: agentError
        };
      }
    }
    const partialMessage = collected ? assistantMessage(collected.response) : void 0;
    if (outcome.kind === "cancelled") {
      try {
        await config.recorder?.finishAssistantAttempt(ctx, "interrupted", partialMessage);
      } catch (error) {
        return finish("failed", toAgentError(error));
      }
      return finish("cancelled");
    }
    if (outcome.kind === "answer" || outcome.kind === "tool_calls") {
      const message = assistantMessage(outcome.response);
      const commitContext = { ...ctx, entryId: randomUUID(), completedAt: clock() };
      let invocations = /* @__PURE__ */ new Map();
      try {
        const inputs = outcome.kind === "tool_calls" ? planToolBatch(outcome.response.toolCalls, ctx, config) : [];
        await commitWithRetry(async () => {
          if (config.recorder) {
            const records = await config.recorder.finishAssistantAttempt(commitContext, "completed", message, inputs);
            invocations = new Map(records.map((record2) => [record2.toolCallId, record2]));
          }
        }, commitRetryConfig, config.signal);
      } catch (error) {
        if (config.signal?.aborted) return finish("cancelled");
        return finish("failed", toAgentError(error));
      }
      if (config.signal?.aborted) return finish("cancelled");
      messages.push(message);
      events.onAssistantCompleted?.(outcome.response, { ...ctx, completedAt: commitContext.completedAt });
      if (outcome.kind === "answer") {
        events.onTurnCompleted?.(ctx);
        try {
          readyInputs = await config.steeringInbox?.takePendingOrSeal() ?? [];
        } catch (error) {
          return finish("failed", toAgentError(error));
        }
        if (readyInputs.length > 0) {
          currentTurnId = void 0;
          continue;
        }
        return finish("completed", void 0, ctx.turnId);
      }
      for (const call of outcome.response.toolCalls) {
        if (config.signal?.aborted) return finish("cancelled");
        events.onToolStart?.(call, ctx);
        const invocation = invocations.get(call.id);
        let toolResult;
        let toolMessage;
        try {
          let executionInvocation = invocation;
          if (invocation?.phase === "completed" || invocation?.phase === "outcome_ready") {
            toolResult = toolResultFromInvocation(invocation);
          } else {
            const recovered = invocation?.phase === "effect_pending" ? await recoverToolInvocation(call, invocation, config) : void 0;
            if (recovered?.kind === "succeeded") toolResult = recovered.result;
            else if (recovered?.kind === "interrupted") toolResult = recovered.result ?? interruptedToolResult(recovered.reason);
            else {
              const executed = await executeToolAttempt(call, config, invocation);
              executionInvocation = executed.invocation;
              toolResult = executed.result;
            }
          }
          toolMessage = await materializeToolResult(call, toolResult, config, executionInvocation, ctx);
        } catch (error) {
          if (error instanceof ToolAttemptBlockedError && error.reason === "cancelled") return finish("cancelled");
          if (config.signal?.aborted && !(error instanceof RepositoryError)) return finish("cancelled");
          return finish("failed", toAgentError(error));
        }
        messages.push(toolMessage);
        events.onToolCompleted?.(call, toolResult, ctx);
      }
      events.onTurnCompleted?.(ctx);
      currentTurnId = void 0;
      continue;
    }
    const attemptStatus = outcome.kind === "incomplete" ? "interrupted" : "failed";
    try {
      await config.recorder?.finishAssistantAttempt(ctx, attemptStatus, partialMessage);
    } catch (error) {
      return finish("failed", toAgentError(error));
    }
    if (outcome.kind === "incomplete") {
      const canRetry = await retryModelTurn({
        runId: config.runId,
        turnId: ctx.turnId,
        attempt,
        reason: outcome.reason,
        maxAttempts: retryConfig.maxAttempts,
        baseDelayMs: retryConfig.baseDelayMs,
        maxDelayMs: retryConfig.maxDelayMs,
        signal: config.signal,
        events
      });
      if (canRetry) continue;
      return finish("failed", { kind: "model_protocol", message: retryFailureMessage(outcome.reason) });
    }
    if (outcome.kind === "failed" && outcome.error.retryable) {
      const reason = outcome.reason === "network_error" ? "network_error" : outcome.reason === "provider_error" ? "provider_error" : "model_protocol";
      const canRetry = await retryModelTurn({
        runId: config.runId,
        turnId: ctx.turnId,
        attempt,
        reason,
        maxAttempts: retryConfig.maxAttempts,
        baseDelayMs: retryConfig.baseDelayMs,
        maxDelayMs: retryConfig.maxDelayMs,
        signal: config.signal,
        events
      });
      if (canRetry) continue;
    }
    return finish("failed", outcome.error);
  }
}
function classifyTurn(response2) {
  if (response2.error) {
    return { kind: "failed", reason: response2.error.kind === "network" ? "network_error" : response2.error.kind === "model_protocol" ? "model_protocol" : "provider_error", error: response2.error };
  }
  if (response2.stopReason === "aborted") return { kind: "cancelled", reason: "aborted" };
  if (response2.stopReason === "content_filter") return { kind: "failed", reason: "content_filtered", error: { kind: "provider", message: "The provider filtered this response." } };
  if (response2.stopReason === "unknown") return { kind: "failed", reason: "unknown_stop_reason", error: { kind: "model_protocol", message: `Unknown model stop reason: ${response2.rawStopReason ?? "unknown"}.` } };
  if (response2.stopReason === "length") return { kind: "incomplete", reason: "length", response: response2 };
  if (response2.toolCalls.length > 0) {
    if (response2.toolCalls.some((call) => !call.inputComplete)) return { kind: "incomplete", reason: "invalid_tool_calls", response: response2 };
    return { kind: "tool_calls", response: response2 };
  }
  if (response2.stopReason === "tool_use") return { kind: "incomplete", reason: "invalid_tool_calls", response: response2 };
  if (response2.content.trim()) return { kind: "answer", response: response2 };
  if (response2.reasoning?.trim()) return { kind: "incomplete", reason: "reasoning_only", response: response2 };
  return { kind: "incomplete", reason: "empty_response", response: response2 };
}
async function retryModelTurn(input) {
  if (input.attempt >= input.maxAttempts || input.signal?.aborted) return false;
  const delayMs = Math.min(input.maxDelayMs, input.baseDelayMs * 2 ** Math.max(0, input.attempt - 1));
  input.events.onTurnRetrying?.({
    runId: input.runId,
    turnId: input.turnId,
    attempt: input.attempt,
    nextAttempt: input.attempt + 1,
    reason: input.reason,
    delayMs,
    maxAttempts: input.maxAttempts
  });
  if (!await waitForRetryDelay(delayMs, input.signal)) return false;
  return !input.signal?.aborted;
}
function toAgentError(error) {
  if (error instanceof ModelAdapterError) return { kind: error.kind, message: error.message, retryable: error.retryable };
  return { kind: "runtime", message: error instanceof Error ? error.message : String(error) };
}
function assistantMessage(response2) {
  return { role: "assistant", content: response2.content, reasoning: response2.reasoning, toolCalls: response2.toolCalls };
}
function retryFailureMessage(reason) {
  const messages = {
    reasoning_only: "The model did not produce a complete response after retries.",
    empty_response: "The model returned an empty response after retries.",
    length: "The model response was truncated after retries.",
    missing_finish_reason: "The model stream ended without a complete termination signal.",
    invalid_tool_calls: "The model did not produce a complete tool call after retries.",
    network_error: "The model request failed after retries.",
    provider_error: "The provider request failed after retries.",
    model_protocol: "The model response did not satisfy the protocol after retries."
  };
  return messages[reason];
}
function waitForRetryDelay(delayMs, signal) {
  if (signal?.aborted) return Promise.resolve(false);
  if (delayMs <= 0) return Promise.resolve(!signal?.aborted);
  return new Promise((resolve2) => {
    let settled = false;
    const onAbort = () => finish(false);
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve2(value);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => finish(!signal?.aborted), delayMs);
  });
}
async function commitWithRetry(operation, policy, signal) {
  for (let attempt = 1; ; attempt += 1) {
    signal?.throwIfAborted();
    try {
      await operation();
      return;
    } catch (error) {
      if (!(error instanceof RepositoryError) || !error.retryable || attempt >= policy.maxAttempts) throw error;
      const delayMs = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (attempt - 1));
      if (!await waitForRetryDelay(delayMs, signal)) throw error;
    }
  }
}
async function recoverOpenToolInvocations(config, runId, forceCancellation = false) {
  const recorder = config.recorder;
  if (!recorder) return;
  const records = await recorder.listOpenToolInvocations(runId);
  let recoveryCancelled = forceCancellation;
  const persistRecoveryCancellation = async () => {
    if (!config.signal?.aborted || recoveryCancelled) return;
    for (const queuedRun of new Set(records.map((record2) => record2.runId))) await recorder.requestRunCancellation(queuedRun);
    recoveryCancelled = true;
  };
  for (const invocation of records) {
    if (invocation.phase === "completed") continue;
    await persistRecoveryCancellation();
    const cancelled = recoveryCancelled || await recorder.isRunCancelled(invocation.runId);
    const call = await recorder.getToolInvocationCall(invocation.id);
    let executionInvocation = invocation;
    let toolResult;
    if (invocation.phase === "outcome_ready") {
      toolResult = toolResultFromInvocation(invocation);
    } else if (cancelled) {
      toolResult = invocation.phase === "planned" ? cancelledToolResult("This tool call was not executed because the user stopped its run.") : interruptedToolResult("The user stopped this run after execution began. Its effects require confirmation; it was not replayed.");
    } else {
      try {
        const registeredTool = config.tools.get(call.name);
        const recovered = invocation.phase === "effect_pending" ? await recoverToolInvocation(call, invocation, config) : !invocation.cwd || !registeredTool || registeredTool.recovery.resumePlanned === false || registeredTool.recovery.version !== invocation.toolVersion ? { kind: "interrupted", reason: `Tool ${call.name} belongs to an earlier run and requires a new request.` } : void 0;
        if (recovered?.kind === "succeeded") toolResult = recovered.result;
        else if (recovered?.kind === "interrupted") toolResult = recovered.result ?? interruptedToolResult(recovered.reason);
        else if (config.signal?.aborted) {
          toolResult = invocation.phase === "planned" ? cancelledToolResult("The user stopped recovery before this tool could execute.") : interruptedToolResult("The user stopped tool recovery; no replay was started.");
        } else {
          const executed = await executeToolAttempt(call, config, invocation);
          executionInvocation = executed.invocation ?? invocation;
          toolResult = executed.result;
        }
      } catch (error) {
        if (error instanceof ToolAttemptBlockedError && error.reason === "cancelled") {
          toolResult = invocation.phase === "planned" ? cancelledToolResult("The run was stopped before execution intent could commit.") : interruptedToolResult("The run was stopped before recovery execution intent could commit.");
        } else {
          if (error instanceof RepositoryError) throw error;
          toolResult = interruptedToolResult(error instanceof Error ? error.message : String(error));
        }
      }
    }
    await persistRecoveryCancellation();
    await materializeToolResult(call, toolResult, config, executionInvocation, {
      runId: invocation.runId,
      turnId: invocation.turnId,
      turnOrdinal: invocation.ordinal
    });
  }
}
function planToolBatch(calls, ctx, config) {
  const inputs = [];
  if (!config.recorder) return inputs;
  for (const [ordinal, call] of calls.entries()) {
    const tool = config.tools.get(call.name);
    const toolVersion = tool?.recovery.version ?? "unknown";
    const recoveryMode = tool?.recovery.mode ?? "never";
    const inputJson = canonicalJson(call.input);
    const inputHash = toolInputHash(call.name, toolVersion, call.input);
    inputs.push({
      runId: ctx.runId,
      turnId: ctx.turnId,
      cwd: config.cwd,
      toolCallId: call.id,
      ordinal,
      toolName: call.name,
      toolVersion,
      inputJson,
      inputHash,
      recoveryModeSnapshot: recoveryMode,
      resultEntryId: randomUUID()
    });
  }
  return inputs;
}
async function recoverToolInvocation(call, invocation, config) {
  const tool = config.tools.get(call.name);
  if (!tool || !config.recorder) return { kind: "interrupted", reason: `Tool ${call.name} is unavailable during recovery.` };
  if (!invocation.cwd) return { kind: "interrupted", reason: "The original execution directory is unavailable. This tool requires a new request." };
  if (config.signal?.aborted || await config.recorder.isRunCancelled(invocation.runId)) return { kind: "interrupted", reason: "The user stopped this run; automatic replay is disabled." };
  if (invocation.phase !== "effect_pending") return void 0;
  if (tool.recovery.version !== invocation.toolVersion) {
    return { kind: "interrupted", reason: `Tool ${call.name} version ${invocation.toolVersion} requires a matching recovery implementation.` };
  }
  if (invocation.recoveryModeSnapshot === "never") return { kind: "interrupted", reason: `Tool ${call.name} requires manual recovery after an interrupted execution.` };
  if (invocation.recoveryModeSnapshot === "reconcile" && !tool.recovery.reconcile) {
    return { kind: "interrupted", reason: `Tool ${call.name} has no recovery reconciler.` };
  }
  if (invocation.recoveryModeSnapshot === "reconcile" && tool.recovery.reconcile) {
    if (config.signal?.aborted) return { kind: "interrupted", reason: "The user stopped tool recovery; reconciliation was not started." };
    const checkpoint = invocationCheckpoint(invocation);
    const recovered = await tool.recovery.reconcile(call.input, checkpoint, {
      cwd: invocation.cwd,
      signal: config.signal,
      invocationId: invocation.id,
      toolCallId: call.id,
      attempt: invocation.attemptCount,
      checkpoint
    });
    if (recovered.kind !== "retry") return recovered;
  }
  return { kind: "retry", reason: "tool recovery permits another execution attempt" };
}
function toolResultFromInvocation(invocation) {
  const result = readToolResult(invocation.outcomeJson);
  if (!result || toolOutcomeStatus(result) !== invocation.outcomeStatus) {
    throw new RepositoryError(`Invalid persisted tool outcome: ${invocation.id}`, "storage");
  }
  return result;
}
function interruptedToolResult(reason) {
  return { ok: false, output: reason, returncode: -1, truncated: false, error: "interrupted" };
}
function cancelledToolResult(reason) {
  return { ok: false, output: reason, returncode: -1, truncated: false, error: "cancelled" };
}
function invocationCheckpoint(invocation) {
  if (invocation.checkpoint == null) return void 0;
  const checkpoint = readToolCheckpoint(invocation.checkpoint);
  if (!checkpoint) throw new RepositoryError(`Invalid tool checkpoint: ${invocation.id}`, "storage");
  return checkpoint;
}
async function executeToolAttempt(call, config, invocation) {
  const immediate = (result) => ({ result, invocation });
  if (config.signal?.aborted) return immediate(invocation?.phase === "effect_pending" ? interruptedToolResult("The user stopped recovery before a new execution attempt.") : cancelledToolResult("The user stopped before this tool could execute."));
  if (invocation?.phase === "planned" && await config.recorder?.isToolInvocationBlocked(invocation.id)) {
    return immediate(interruptedToolResult("This tool call was skipped because an earlier call in its batch has an uncertain outcome."));
  }
  if (!call.inputComplete) return immediate(invalidResult("The tool arguments were truncated by the model response and were not executed. Please regenerate the complete tool call.", "truncated_arguments"));
  const tool = config.tools.get(call.name);
  if (!tool) return immediate(invalidResult(`Unknown tool: ${call.name}`, "unknown_tool"));
  const preparationContext = {
    cwd: invocation?.cwd ?? config.cwd,
    signal: config.signal,
    invocationId: invocation?.id,
    toolCallId: call.id,
    attempt: (invocation?.attemptCount ?? 0) + 1
  };
  let prepared;
  try {
    prepared = tool.prepare ? await tool.prepare(call.input, preparationContext) : { kind: "ready", execute: (context) => tool.execute(call.input, context) };
    if (prepared.kind === "result") {
      const result = readToolResult(prepared.result);
      if (!result || result.ok) throw new Error("Preparation must return a valid unsuccessful result or a prepared execution.");
      return immediate(result);
    }
    if (prepared.checkpoint && !readToolCheckpoint(prepared.checkpoint)) throw new Error("Preparation returned an invalid checkpoint.");
  } catch (error) {
    return immediate(config.signal?.aborted ? cancelledToolResult("The user stopped during tool preparation.") : invalidResult(error instanceof Error ? error.message : String(error), "preparation_failed"));
  }
  if (config.signal?.aborted) return immediate(cancelledToolResult("The user stopped before execution intent was persisted."));
  let executing = invocation;
  try {
    if (invocation && config.recorder) executing = await config.recorder.beginToolAttempt(invocation.id, prepared.checkpoint);
  } catch (error) {
    if (error instanceof ToolAttemptBlockedError && error.reason === "prior_interrupted") {
      return immediate(interruptedToolResult("This tool call was skipped because an earlier call in its batch has an uncertain outcome."));
    }
    throw error;
  }
  if (config.signal?.aborted) return { result: interruptedToolResult("The user stopped after intent was persisted; execution was not started."), invocation: executing };
  try {
    const result = await prepared.execute({ ...preparationContext, attempt: executing?.attemptCount ?? 1, checkpoint: prepared.checkpoint });
    const validated = readToolResult(result);
    if (!validated) throw new Error(`Tool ${call.name} returned an invalid result.`);
    return { result: validated, invocation: executing };
  } catch (error) {
    return { result: interruptedToolResult(error instanceof Error ? error.message : String(error)), invocation: executing };
  }
}
async function materializeToolResult(call, result, config, invocation, context) {
  if (!readToolResult(result)) throw new Error(`Tool ${call.name} returned an invalid result.`);
  const message = toolResultMessage(call, result);
  const entryId = invocation?.resultEntryId ?? randomUUID();
  await commitWithRetry(async () => {
    if (invocation && config.recorder) {
      const outcome = { status: toolOutcomeStatus(result), outcome: result };
      if (invocation.phase === "planned") await config.recorder.settleUnstartedToolInvocation(invocation.id, outcome);
      else if (invocation.phase === "effect_pending") await config.recorder.saveToolOutcome(invocation.id, outcome);
    }
    await config.recorder?.commitToolResult(message, { ...context, toolCallId: call.id, entryId, invocationId: invocation?.id });
  }, { ...DEFAULT_COMMIT_RETRY, ...config.commitRetry });
  return message;
}
function invalidResult(output, error) {
  return { ok: false, output, returncode: -1, truncated: false, error };
}
const MAX_OUTPUT = 1e4;
const TRUNCATE_KEEP = 6e3;
const MAX_SNAPSHOT_ENTRIES = 12e3;
const MAX_SNAPSHOT_FILES = 8e3;
const MAX_SNAPSHOT_DEPTH = 16;
const MAX_ARTIFACTS_PER_COMMAND = 256;
const SNAPSHOT_IGNORED_DIRECTORIES = /* @__PURE__ */ new Set([
  ".git",
  ".hg",
  ".svn",
  ".cache",
  ".next",
  ".superpowers",
  ".turbo",
  ".venv",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
  "venv"
]);
function createLocalBashOps() {
  return {
    async exec(command, cwd, opts) {
      return runWithSpawn(command, cwd, opts);
    }
  };
}
function runWithSpawn(cmd, cwd, opts) {
  return runWithArtifactSnapshot(cmd, cwd, opts);
}
async function runWithArtifactSnapshot(cmd, cwd, opts) {
  const before = await snapshotDirectory(cwd);
  const result = await spawnCommand(cmd, cwd, opts);
  const after = await snapshotDirectory(cwd);
  const artifacts = diffSnapshots(before, after);
  return artifacts.length > 0 ? { ...result, artifacts } : result;
}
function spawnCommand(cmd, cwd, opts) {
  return new Promise((resolve2, reject) => {
    if (opts.signal?.aborted) {
      reject(new Error("The command was cancelled."));
      return;
    }
    const child = spawn("bash", ["-c", cmd], { cwd, timeout: opts.timeout ? opts.timeout * 1e3 : 3e4 });
    const chunks = [];
    child.stdout.on("data", (d) => {
      chunks.push(d.toString());
    });
    child.stderr.on("data", (d) => {
      chunks.push(d.toString());
    });
    let settled = false;
    const abort = () => {
      child.kill("SIGKILL");
    };
    const cleanup = () => {
      opts.signal?.removeEventListener("abort", abort);
    };
    opts.signal?.addEventListener("abort", abort, { once: true });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      const raw = chunks.join("");
      if (raw.length > MAX_OUTPUT) {
        const dir = mkdtempSync(join$1(tmpdir(), "ts-agent-"));
        const fullPath = join$1(dir, "full_output.log");
        writeFileSync(fullPath, raw);
        const tail = raw.slice(-TRUNCATE_KEEP);
        resolve2({
          output: tail + `

... ${raw.length - TRUNCATE_KEEP} characters omitted; full output saved to an internal temporary file ...`,
          returncode: code ?? -1,
          truncated: true,
          fullOutputPath: fullPath
        });
      } else {
        resolve2({ output: raw, returncode: code ?? -1, truncated: false });
      }
    });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    });
  });
}
async function snapshotDirectory(cwd) {
  const files = /* @__PURE__ */ new Map();
  let complete = true;
  let root;
  try {
    root = await realpath(cwd);
  } catch {
    return { files, complete: false };
  }
  const directories = [{ path: root, depth: 0 }];
  let visitedEntries = 0;
  while (directories.length > 0) {
    const current = directories.pop();
    if (!current) break;
    let directory;
    try {
      directory = await opendir(current.path);
    } catch {
      complete = false;
      continue;
    }
    try {
      for await (const entry of directory) {
        visitedEntries += 1;
        if (visitedEntries > MAX_SNAPSHOT_ENTRIES) {
          complete = false;
          return { files, complete };
        }
        const entryPath = join$1(current.path, entry.name);
        let stats;
        try {
          stats = await lstat(entryPath);
        } catch {
          complete = false;
          continue;
        }
        if (stats.isSymbolicLink()) continue;
        if (stats.isDirectory()) {
          if (SNAPSHOT_IGNORED_DIRECTORIES.has(entry.name)) continue;
          if (current.depth >= MAX_SNAPSHOT_DEPTH) {
            complete = false;
            continue;
          }
          directories.push({ path: entryPath, depth: current.depth + 1 });
          continue;
        }
        if (!stats.isFile()) continue;
        if (files.size >= MAX_SNAPSHOT_FILES) {
          complete = false;
          return { files, complete };
        }
        files.set(entryPath, {
          path: entryPath,
          size: stats.size,
          mtimeMs: stats.mtimeMs,
          ctimeMs: stats.ctimeMs,
          mediaType: mediaTypeForPath(entryPath),
          updatedAt: stats.mtime.toISOString()
        });
      }
    } catch {
      complete = false;
    }
  }
  return { files, complete };
}
function diffSnapshots(before, after) {
  const artifacts = [];
  for (const [path, current] of after.files) {
    const previous = before.files.get(path);
    let operation;
    if (!previous) {
      if (before.complete) operation = "created";
    } else if (previous.size !== current.size || previous.mtimeMs !== current.mtimeMs || previous.ctimeMs !== current.ctimeMs) {
      operation = "updated";
    }
    if (!operation) continue;
    artifacts.push({
      path: current.path,
      operation,
      mediaType: current.mediaType,
      byteSize: current.size,
      updatedAt: current.updatedAt
    });
    if (artifacts.length >= MAX_ARTIFACTS_PER_COMMAND) break;
  }
  return artifacts;
}
function mediaTypeForPath(path) {
  switch (extname(path).toLowerCase()) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".md":
    case ".markdown":
      return "text/markdown";
    case ".json":
      return "application/json";
    case ".html":
    case ".htm":
      return "text/html";
    case ".css":
      return "text/css";
    case ".csv":
      return "text/csv";
    case ".xml":
      return "application/xml";
    case ".yaml":
    case ".yml":
      return "application/yaml";
    case ".js":
    case ".jsx":
    case ".mjs":
    case ".cjs":
      return "text/javascript";
    case ".ts":
    case ".tsx":
      return "text/typescript";
    case ".txt":
    case ".log":
    case ".sh":
    case ".bash":
    case ".zsh":
    case ".py":
    case ".rb":
    case ".go":
    case ".rs":
    case ".java":
    case ".kt":
    case ".swift":
    case ".c":
    case ".h":
    case ".cpp":
    case ".hpp":
    case ".sql":
    case ".toml":
    case ".ini":
    case ".conf":
      return "text/plain";
    default:
      return "application/octet-stream";
  }
}
const BASH_TOOL = {
  name: "bash",
  description: "Execute a bash command on the local machine",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "The bash command to execute" }
    },
    required: ["command"]
  }
};
function createBashTool(ops) {
  return {
    definition: BASH_TOOL,
    recovery: { version: "1", mode: "never" },
    async execute(input, context) {
      if (typeof input.command !== "string" || input.command.trim() === "") {
        return { ok: false, output: "Tool parameter command must be a non-empty string.", returncode: -1, truncated: false, error: "invalid_arguments" };
      }
      try {
        const result = await ops.exec(input.command, context.cwd, { timeout: 30, signal: context.signal });
        return { ...result, ok: result.returncode === 0, error: result.returncode === 0 ? void 0 : "command_failed" };
      } catch (error) {
        return { ok: false, output: error instanceof Error ? error.message : String(error), returncode: -1, truncated: false, error: "execution_failed" };
      }
    }
  };
}
const READ_TOOL = {
  name: "read",
  description: "Read a text file by lines, or an image file as visual content. Returns the read range and the next start line when truncated.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path, absolute or relative to the workspace root" },
      start: { type: "integer", description: "1-based line to start reading from (default 1)" },
      maxLines: { type: "integer", description: "Maximum lines to return (default 1000, max 5000)" }
    },
    required: ["path"]
  }
};
const DEFAULT_MAX_LINES = 1e3;
const MAX_LINES = 5e3;
const MAX_LINE_DISPLAY = 2e3;
const IMAGE_EXTENSIONS = /* @__PURE__ */ new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);
function createReadTool() {
  return {
    definition: READ_TOOL,
    recovery: { version: "1", mode: "safe" },
    async execute(input, context) {
      if (typeof input.path !== "string" || input.path.trim() === "") {
        return { ok: false, output: "Tool parameter path must be a non-empty string.", returncode: -1, truncated: false, error: "invalid_arguments" };
      }
      const start = typeof input.start === "number" && Number.isInteger(input.start) && input.start >= 1 ? input.start : 1;
      let maxLines = typeof input.maxLines === "number" && Number.isInteger(input.maxLines) ? input.maxLines : DEFAULT_MAX_LINES;
      maxLines = Math.min(Math.max(maxLines, 1), MAX_LINES);
      const target = isAbsolute(input.path) ? input.path : resolve(context.cwd, input.path);
      let stats;
      try {
        stats = await stat(target);
      } catch {
        return { ok: false, output: `File not found: ${input.path}`, returncode: -1, truncated: false, error: "not_found" };
      }
      if (stats.isDirectory()) {
        return { ok: false, output: `Target is a directory; Read expects a file: ${input.path}`, returncode: -1, truncated: false, error: "target_is_directory" };
      }
      const ext = extname(target).toLowerCase();
      let buffer;
      try {
        buffer = await readFile(target);
      } catch (error) {
        return { ok: false, output: `Read failed: ${error instanceof Error ? error.message : String(error)}`, returncode: -1, truncated: false, error: "read_failed" };
      }
      if (IMAGE_EXTENSIONS.has(ext)) {
        const dataUrl = `data:${mimeForExtension(ext)};base64,${buffer.toString("base64")}`;
        return {
          ok: true,
          output: `Image returned as visual content: ${input.path} (${stats.size} bytes)`,
          returncode: 0,
          truncated: false,
          media: { mediaType: mimeForExtension(ext), dataUrl }
        };
      }
      if (buffer.includes(0)) {
        return { ok: false, output: `File is neither text nor a model-supported image format: ${input.path}`, returncode: -1, truncated: false, error: "binary_file" };
      }
      const raw = buffer.toString("utf8");
      const lines = raw.split("\n");
      if (lines.at(-1) === "") lines.pop();
      const from = Math.min(start, lines.length + 1);
      const page = lines.slice(from - 1, from - 1 + maxLines);
      const linesTruncated = lines.length > from - 1 + page.length;
      const nextStart = linesTruncated ? from + page.length : void 0;
      const rel = relative(context.cwd, target) || target;
      const rendered = page.map((line, i) => {
        const display = line.length > MAX_LINE_DISPLAY ? `${line.slice(0, MAX_LINE_DISPLAY)} …(Line too long; truncated)` : line;
        return `${from + i}: ${display}`;
      });
      const rangeNote = linesTruncated ? `Read lines ${from}-${from + page.length - 1} of ${lines.length}; continue with start=${nextStart}` : `Read ${lines.length} lines`;
      return {
        ok: true,
        output: `<file>${rel}</file>
${rangeNote}
<content>
${rendered.join("\n")}
</content>`,
        returncode: 0,
        truncated: linesTruncated
      };
    }
  };
}
function mimeForExtension(ext) {
  switch (ext) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    default:
      return "application/octet-stream";
  }
}
class FilePublicationError extends Error {
  constructor(code, message, published = false) {
    super(message);
    this.code = code;
    this.published = published;
  }
  code;
  published;
}
function hashBytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
function isRecord$3(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function hasCode(error, code) {
  return isRecord$3(error) && error.code === code;
}
function checkFileCancellation(context) {
  if (context.signal?.aborted) throw new FilePublicationError("cancelled", "The attempt was cancelled before publication.");
}
function fileErrorResult(label, error, fallback = "write_failed") {
  const code = error instanceof FilePublicationError ? error.code : hasCode(error, "EACCES") || hasCode(error, "EPERM") ? "permission_denied" : hasCode(error, "ENOENT") ? "not_found" : fallback;
  return { ok: false, output: `${label} failed: ${error instanceof Error ? error.message : String(error)}`, returncode: -1, truncated: false, error: code };
}
async function physicalPath(path, depth = 0) {
  if (depth > 64) throw new FilePublicationError("unsupported_file", "The target's symbolic link chain is too deep.");
  try {
    return await fs.realpath(path);
  } catch (error) {
    if (!hasCode(error, "ENOENT")) throw error;
  }
  try {
    const entry = await fs.lstat(path);
    if (entry.isSymbolicLink()) return physicalPath(resolve(dirname(path), await fs.readlink(path)), depth + 1);
    return await fs.realpath(path);
  } catch (error) {
    if (!hasCode(error, "ENOENT")) throw error;
  }
  const parent = dirname(path);
  if (parent === path) throw new FilePublicationError("not_found", `The filesystem root is unavailable: ${path}`);
  return resolve(await physicalPath(parent, depth + 1), basename(path));
}
function assertRegular(stats, path) {
  if (stats.isDirectory()) throw new FilePublicationError("target_is_directory", `The target is a directory: ${path}`);
  if (!stats.isFile()) throw new FilePublicationError("unsupported_file", `Atomic publication requires a regular file: ${path}`);
  if (stats.nlink !== 1) throw new FilePublicationError("unsupported_file", `Atomic publication requires a single-link file: ${path}`);
}
function sameMetadata(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode && left.uid === right.uid && left.gid === right.gid && left.nlink === right.nlink && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}
function sameFileState(left, right) {
  if (!left.exists || !right.exists) return left.exists === right.exists;
  return left.hash === right.hash && sameMetadata(left, right);
}
async function readRegularFile(path) {
  let entry;
  try {
    entry = await fs.lstat(path);
  } catch (error) {
    if (hasCode(error, "ENOENT")) return { state: { exists: false }, bytes: null };
    throw error;
  }
  assertRegular(entry, path);
  const handle = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat();
    assertRegular(before, path);
    if (!sameMetadata(entry, before)) throw new FilePublicationError("file_changed", `The target changed while opening: ${path}`);
    const bytes = await handle.readFile();
    const after = await handle.stat();
    const current = await fs.lstat(path);
    if (!sameMetadata(before, after) || !sameMetadata(after, current) || bytes.length !== after.size) {
      throw new FilePublicationError("file_changed", `The target changed while reading: ${path}`);
    }
    return {
      state: {
        exists: true,
        hash: hashBytes(bytes),
        dev: after.dev,
        ino: after.ino,
        mode: after.mode,
        uid: after.uid,
        gid: after.gid,
        nlink: after.nlink,
        size: after.size,
        mtimeMs: after.mtimeMs,
        ctimeMs: after.ctimeMs
      },
      bytes
    };
  } finally {
    await handle.close();
  }
}
async function observeFile(path) {
  const targetPath = await physicalPath(path);
  const file = await readRegularFile(targetPath);
  if (await physicalPath(path) !== targetPath) throw new FilePublicationError("file_changed", `The target's symbolic link changed: ${path}`);
  return { path, targetPath, ...file };
}
function stagingName(invocationId, attempt, token) {
  return `.agent-file-${hashBytes(Buffer.from(invocationId)).slice(0, 24)}-${attempt}-${token}.tmp`;
}
function containsDirectory(ancestor, directory) {
  const suffix = relative(ancestor, directory);
  return suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix);
}
async function establishedDirectory(parent) {
  for (let path = parent; ; path = dirname(path)) {
    try {
      const entry = await fs.lstat(path);
      if (!entry.isDirectory()) throw new FilePublicationError("file_changed", `The publication ancestor is not a physical directory: ${path}`);
      return { path, dev: entry.dev, ino: entry.ino };
    } catch (error) {
      if (!hasCode(error, "ENOENT") || dirname(path) === path) throw error;
    }
  }
}
async function syncPublicationDirectories(targetPath, boundary, parentHandle) {
  const parent = dirname(targetPath);
  const stop = boundary?.path ?? parse(parent).root;
  if (!containsDirectory(stop, parent)) throw new FilePublicationError("interrupted", "The durability boundary is outside the target's directory chain.");
  for (let path = parent; ; path = dirname(path)) {
    const retained = path === parent && parentHandle !== void 0;
    const handle = retained ? parentHandle : await fs.open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      const opened = await handle.stat();
      const entry = await fs.lstat(path);
      if (!opened.isDirectory() || !entry.isDirectory() || opened.dev !== entry.dev || opened.ino !== entry.ino || boundary && path === stop && (opened.dev !== boundary.dev || opened.ino !== boundary.ino)) {
        throw new FilePublicationError("interrupted", `The durability directory identity changed: ${path}`);
      }
      await handle.sync();
      const current = await fs.lstat(path);
      if (!current.isDirectory() || opened.dev !== current.dev || opened.ino !== current.ino) {
        throw new FilePublicationError("interrupted", `The durability directory changed while syncing: ${path}`);
      }
    } finally {
      if (!retained) await handle.close();
    }
    if (path === stop) return;
  }
}
async function syncObservedFile(source) {
  const expected = source.state;
  if (!expected.exists) throw new FilePublicationError("interrupted", "The recovered target is absent during durability confirmation.");
  const handle = await fs.open(source.targetPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = await handle.stat();
    assertRegular(opened, source.targetPath);
    if (!sameMetadata(expected, opened)) throw new FilePublicationError("interrupted", "The recovered target changed before file sync.");
    await handle.sync();
    if (!sameMetadata(expected, await handle.stat()) || !sameMetadata(expected, await fs.lstat(source.targetPath))) {
      throw new FilePublicationError("interrupted", "The recovered target changed during file sync.");
    }
  } finally {
    await handle.close();
  }
}
async function planFilePublication(source, bytes, context) {
  checkFileCancellation(context);
  if (source.state.exists) await fs.access(source.targetPath, constants.W_OK);
  if (context.invocationId !== void 0 && (!context.invocationId || context.invocationId.includes("\0"))) {
    throw new FilePublicationError("invalid_arguments", "The invocation identity must be a non-empty string without NUL.");
  }
  const attempt = context.attempt ?? 1;
  if (!Number.isSafeInteger(attempt) || attempt < 1) throw new FilePublicationError("invalid_arguments", "The attempt must be a positive integer.");
  const token = randomBytes(16).toString("hex");
  const invocationId = context.invocationId ?? `direct:${token}`;
  const directoryBoundary = await establishedDirectory(dirname(source.targetPath));
  checkFileCancellation(context);
  return {
    source: { ...source, bytes: null },
    bytes,
    afterHash: hashBytes(bytes),
    afterMode: source.state.exists ? source.state.mode & 4095 : 438 & ~process.umask(),
    cwd: resolve(context.cwd),
    invocationId: context.invocationId,
    attempt: context.attempt,
    directoryBoundary,
    staging: { invocationId, attempt, token, relativePath: stagingName(invocationId, attempt, token) }
  };
}
const publicationQueues = /* @__PURE__ */ new Map();
async function waitForTurn(previous, signal) {
  if (!signal) return previous;
  if (signal.aborted) throw new FilePublicationError("cancelled", "The attempt was cancelled while waiting for publication.");
  let onAbort = () => {
  };
  const cancelled = new Promise((_, reject) => {
    onAbort = () => reject(new FilePublicationError("cancelled", "The attempt was cancelled while waiting for publication."));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    await Promise.race([previous, cancelled]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}
async function withFilePublicationLock(path, signal, action) {
  const previous = publicationQueues.get(path) ?? Promise.resolve();
  let release = () => {
  };
  const gate = new Promise((done) => {
    release = done;
  });
  const tail = previous.then(() => gate);
  publicationQueues.set(path, tail);
  try {
    await waitForTurn(previous, signal);
    return await action();
  } finally {
    release();
    void tail.then(() => {
      if (publicationQueues.get(path) === tail) publicationQueues.delete(path);
    });
  }
}
async function verifySource(source) {
  const current = await observeFile(source.path);
  if (current.targetPath !== source.targetPath || !sameFileState(source.state, current.state)) {
    throw new FilePublicationError("file_changed", `The target differs from the prepared source: ${source.path}`);
  }
  if (current.state.exists) await fs.access(current.targetPath, constants.W_OK);
}
async function cleanupCreatedStage(path, created) {
  let entry;
  try {
    entry = await fs.lstat(path);
  } catch (error) {
    if (hasCode(error, "ENOENT")) return;
    throw error;
  }
  if (!entry.isFile() || entry.nlink !== 1 || entry.dev !== created.dev || entry.ino !== created.ino || entry.birthtimeMs !== created.birthtimeMs) {
    throw new FilePublicationError("interrupted", "The staging identity changed; its path requires inspection.");
  }
  await fs.unlink(path);
}
async function publishFile(plan, context) {
  checkFileCancellation(context);
  await verifySource(plan.source);
  const parent = dirname(plan.source.targetPath);
  await fs.mkdir(parent, { recursive: true });
  const directory = await fs.open(parent, constants.O_RDONLY | constants.O_DIRECTORY);
  let stage;
  let created;
  let closed = false;
  let published = false;
  let renameStarted = false;
  let failure2;
  const stagingPath = resolve(parent, plan.staging.relativePath);
  try {
    const directoryState = await directory.stat();
    checkFileCancellation(context);
    stage = await fs.open(stagingPath, "wx", 384);
    created = await stage.stat();
    await stage.writeFile(plan.bytes);
    if (plan.source.state.exists) {
      const before = plan.source.state;
      if (created.uid !== before.uid || created.gid !== before.gid) await stage.chown(before.uid, before.gid);
    }
    await stage.chmod(plan.afterMode);
    await stage.sync();
    await stage.close();
    closed = true;
    const staged = await readRegularFile(stagingPath);
    if (!staged.state.exists || staged.state.dev !== created.dev || staged.state.ino !== created.ino || staged.state.hash !== plan.afterHash || (staged.state.mode & 4095) !== plan.afterMode || plan.source.state.exists && (staged.state.uid !== plan.source.state.uid || staged.state.gid !== plan.source.state.gid)) {
      throw new FilePublicationError("file_changed", "The prepared staging bytes or identity changed before publication.");
    }
    const currentDirectory = await fs.stat(parent);
    if (directoryState.dev !== currentDirectory.dev || directoryState.ino !== currentDirectory.ino) {
      throw new FilePublicationError("file_changed", "The publication directory changed during staging.");
    }
    await verifySource(plan.source);
    checkFileCancellation(context);
    renameStarted = true;
    await fs.rename(stagingPath, plan.source.targetPath);
    published = true;
    await syncPublicationDirectories(plan.source.targetPath, plan.directoryBoundary, directory);
  } catch (error) {
    failure2 = renameStarted ? new FilePublicationError("interrupted", `${published ? "The file was published; directory durability confirmation failed" : "The publication outcome requires inspection"}: ${error instanceof Error ? error.message : String(error)}`, published) : error;
  } finally {
    try {
      if (stage && !closed) await stage.close();
    } catch (error) {
      failure2 ??= error;
    }
    try {
      if (created && !published) await cleanupCreatedStage(stagingPath, created);
      else if (stage && !created) throw new FilePublicationError("interrupted", "The created staging inode could not be inspected; its receipt requires inspection.");
    } catch (error) {
      failure2 = new FilePublicationError("interrupted", `Staging cleanup requires inspection: ${error instanceof Error ? error.message : String(error)}`, published);
    }
    try {
      await directory.close();
    } catch (error) {
      failure2 ??= new FilePublicationError(published ? "interrupted" : "write_failed", `Directory close failed: ${String(error)}`, published);
    }
  }
  if (failure2 !== void 0) throw failure2;
}
function filePublicationExecution(plan, checkpoint, label, output, mediaType) {
  const success = () => ({ ok: true, output, returncode: 0, truncated: false, artifacts: [{
    path: plan.source.path,
    operation: plan.source.state.exists ? "updated" : "created",
    mediaType,
    byteSize: plan.bytes.length,
    updatedAt: (/* @__PURE__ */ new Date()).toISOString()
  }] });
  let execution;
  return { kind: "ready", checkpoint, execute(context) {
    if (resolve(context.cwd) !== plan.cwd || context.invocationId !== plan.invocationId || context.attempt !== plan.attempt) {
      return Promise.resolve(fileErrorResult(label, new FilePublicationError("invalid_arguments", "The prepared plan belongs to a different invocation, attempt, or workspace.")));
    }
    execution ??= withFilePublicationLock(plan.source.targetPath, context.signal, async () => {
      await publishFile(plan, context);
      return success();
    }).catch((error) => {
      const result = fileErrorResult(label, error);
      if (error instanceof FilePublicationError && error.published) result.artifacts = success().artifacts;
      return result;
    });
    return execution;
  } };
}
function resolveToolPath(value, cwd) {
  return resolve(cwd, value);
}
function checkpointForFilePublication(plan, mediaType) {
  return { version: 2, kind: "text_file", data: {
    path: plan.source.path,
    targetPath: plan.source.targetPath,
    before: { ...plan.source.state },
    beforeHash: plan.source.state.exists ? plan.source.state.hash : null,
    afterHash: plan.afterHash,
    afterMode: plan.afterMode,
    operation: plan.source.state.exists ? "updated" : "created",
    mediaType,
    byteSize: plan.bytes.length,
    staging: { ...plan.staging },
    directoryBoundary: { ...plan.directoryBoundary }
  } };
}
function validPath(value) {
  return typeof value === "string" && value.length > 0 && !value.includes("\0") && isAbsolute(value) && resolve(value) === value;
}
function validHash(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}
function nonnegativeInteger(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function parseBefore(value) {
  if (!isRecord$3(value)) return void 0;
  if (value.exists === false) return { exists: false };
  if (value.exists !== true || !validHash(value.hash) || !nonnegativeInteger(value.dev) || !nonnegativeInteger(value.ino) || !nonnegativeInteger(value.mode) || (value.mode & constants.S_IFMT) !== constants.S_IFREG || !nonnegativeInteger(value.uid) || !nonnegativeInteger(value.gid) || value.nlink !== 1 || !nonnegativeInteger(value.size) || typeof value.mtimeMs !== "number" || !Number.isFinite(value.mtimeMs) || typeof value.ctimeMs !== "number" || !Number.isFinite(value.ctimeMs)) return void 0;
  return {
    exists: true,
    hash: value.hash,
    dev: value.dev,
    ino: value.ino,
    mode: value.mode,
    uid: value.uid,
    gid: value.gid,
    nlink: value.nlink,
    size: value.size,
    mtimeMs: value.mtimeMs,
    ctimeMs: value.ctimeMs
  };
}
function parseStaging(value, context) {
  if (!isRecord$3(value) || typeof value.invocationId !== "string" || !value.invocationId || value.invocationId.includes("\0") || !nonnegativeInteger(value.attempt) || value.attempt < 1 || typeof value.token !== "string" || !/^[a-f0-9]{32}$/.test(value.token) || typeof value.relativePath !== "string" || value.relativePath !== stagingName(value.invocationId, value.attempt, value.token) || context.invocationId !== void 0 && context.invocationId !== value.invocationId || context.attempt !== void 0 && context.attempt !== value.attempt) return void 0;
  return { invocationId: value.invocationId, attempt: value.attempt, token: value.token, relativePath: value.relativePath };
}
function parseFileCheckpoint(checkpoint, context) {
  if (!isRecord$3(checkpoint) || checkpoint.kind !== "text_file" || checkpoint.version !== 1 && checkpoint.version !== 2 || !isRecord$3(checkpoint.data)) return void 0;
  const data = checkpoint.data;
  if (!validPath(data.path) || data.beforeHash !== null && !validHash(data.beforeHash) || !validHash(data.afterHash) || data.operation !== "created" && data.operation !== "updated" || data.operation === "created" !== (data.beforeHash === null) || typeof data.mediaType !== "string" || !data.mediaType || !nonnegativeInteger(data.byteSize)) return void 0;
  const common = {
    path: data.path,
    beforeHash: data.beforeHash,
    afterHash: data.afterHash,
    operation: data.operation,
    mediaType: data.mediaType,
    byteSize: data.byteSize
  };
  if (checkpoint.version === 1) return { ...common, version: 1 };
  const before = parseBefore(data.before);
  const staging = parseStaging(data.staging, context);
  if (!validPath(data.targetPath) || !before || !staging || (before.exists ? before.hash : null) !== data.beforeHash || !nonnegativeInteger(data.afterMode) || data.afterMode > 4095 || before.exists && (before.mode & 4095) !== data.afterMode) return void 0;
  let directoryBoundary;
  if (data.directoryBoundary !== void 0) {
    const boundary = data.directoryBoundary;
    if (!isRecord$3(boundary) || !validPath(boundary.path) || !nonnegativeInteger(boundary.dev) || !nonnegativeInteger(boundary.ino) || !containsDirectory(boundary.path, dirname(data.targetPath))) return void 0;
    directoryBoundary = { path: boundary.path, dev: boundary.dev, ino: boundary.ino };
  }
  return { ...common, version: 2, targetPath: data.targetPath, before, afterMode: data.afterMode, staging, directoryBoundary };
}
function samePermissions(before, current) {
  return current.mode === before.mode && current.uid === before.uid && current.gid === before.gid;
}
async function cleanupRecordedStaging(data) {
  const path = resolve(dirname(data.targetPath), data.staging.relativePath);
  const staged = await readRegularFile(path);
  if (!staged.state.exists) return;
  if (staged.state.hash !== data.afterHash || staged.state.size !== data.byteSize || (staged.state.mode & 4095) !== data.afterMode || data.before.exists && !samePermissions(data.before, staged.state)) {
    throw new Error("Staging bytes or metadata differ from the attempt receipt.");
  }
  const entry = await fs.lstat(path);
  if (!entry.isFile() || entry.nlink !== 1 || entry.dev !== staged.state.dev || entry.ino !== staged.state.ino) {
    throw new Error("Staging identity changed during recovery inspection.");
  }
  await fs.unlink(path);
}
async function reconcileTextFile(checkpoint, context, label, inputPath) {
  const data = parseFileCheckpoint(checkpoint, context);
  if (!data || typeof inputPath !== "string" || !inputPath.trim() || inputPath.includes("\0") || resolveToolPath(inputPath, context.cwd) !== data.path) {
    return { kind: "interrupted", reason: `${label} recovery checkpoint is unavailable or unsupported.` };
  }
  try {
    const observed = await observeFile(data.path);
    const targetPath = data.version === 2 ? data.targetPath : observed.targetPath;
    return await withFilePublicationLock(targetPath, context.signal, async () => {
      const current = await observeFile(data.path);
      if (current.targetPath !== targetPath) return { kind: "interrupted", reason: `${label} symbolic link target differs from its checkpoint.` };
      const state = current.state;
      const currentHash = state.exists ? state.hash : null;
      const after = state.exists && currentHash === data.afterHash && state.size === data.byteSize && (data.version === 1 || (state.mode & 4095) === data.afterMode && (!data.before.exists || samePermissions(data.before, state)));
      const before = currentHash === data.beforeHash && (data.version === 1 || sameFileState(state, data.before));
      if (!after && !before || currentHash === data.afterHash && !after) return { kind: "interrupted", reason: `${label} target differs from both recorded before and after states: ${data.path}` };
      if (data.version === 2) await cleanupRecordedStaging(data);
      if (after) {
        await syncObservedFile(current);
        await syncPublicationDirectories(targetPath, data.version === 2 ? data.directoryBoundary : void 0);
        const durable = await observeFile(data.path);
        if (durable.targetPath !== targetPath || !sameFileState(current.state, durable.state)) {
          return { kind: "interrupted", reason: `${label} target changed during durability confirmation: ${data.path}` };
        }
        const result = {
          ok: true,
          output: `${label} was already applied and its result was recovered: ${data.path}`,
          returncode: 0,
          truncated: false,
          artifacts: [{ path: data.path, operation: data.operation, mediaType: data.mediaType, byteSize: data.byteSize, updatedAt: (/* @__PURE__ */ new Date()).toISOString() }]
        };
        return { kind: "succeeded", result };
      }
      return { kind: "retry", reason: `${label} was not published; retrying from the recorded before state.` };
    });
  } catch (error) {
    return { kind: "interrupted", reason: `${label} recovery could not verify ${data.path}: ${error instanceof Error ? error.message : String(error)}` };
  }
}
const WRITE_TOOL = {
  name: "write",
  description: "Create a file, or overwrite an existing file with the full given content. Creates missing parent directories.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Target file path, absolute or relative to the workspace root" },
      content: { type: "string", description: "Complete file content to write" }
    },
    required: ["path", "content"]
  }
};
function createWriteTool() {
  return {
    definition: WRITE_TOOL,
    recovery: {
      version: "1",
      mode: "reconcile",
      reconcile: (input, checkpoint, context) => reconcileTextFile(checkpoint, context, "Write", input.path)
    },
    prepare: prepareWrite,
    async execute(input, context) {
      const prepared = await prepareWrite(input, context);
      return prepared.kind === "result" ? prepared.result : prepared.execute(context);
    }
  };
}
async function prepareWrite(input, context) {
  if (typeof input.path !== "string" || input.path.trim() === "" || input.path.includes("\0")) {
    return { kind: "result", result: { ok: false, output: "Tool parameter path must be a non-empty string without NUL.", returncode: -1, truncated: false, error: "invalid_arguments" } };
  }
  if (typeof input.content !== "string") {
    return { kind: "result", result: { ok: false, output: "Tool parameter content must be a string.", returncode: -1, truncated: false, error: "invalid_arguments" } };
  }
  try {
    checkFileCancellation(context);
    const target = resolveToolPath(input.path, context.cwd);
    const source = await observeFile(target);
    const plan = await planFilePublication(source, Buffer.from(input.content, "utf8"), context);
    const mediaType = mediaTypeForPath(target);
    const rel = relative(context.cwd, target) || target;
    const output = `Wrote ${rel} (${plan.bytes.length} bytes, ${source.state.exists ? "overwritten" : "created"})`;
    return filePublicationExecution(plan, checkpointForFilePublication(plan, mediaType), "Write", output, mediaType);
  } catch (error) {
    return { kind: "result", result: fileErrorResult("Write", error, "read_failed") };
  }
}
const EDIT_TOOL = {
  name: "edit",
  description: "Apply non-overlapping text replacements to an existing text file. Each oldText must match exactly once; the whole call fails if any check fails (no partial write).",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path, absolute or relative to the workspace root" },
      edits: {
        type: "array",
        description: "Replacements, all checked against the current file content before writing",
        items: {
          type: "object",
          description: "One replacement",
          properties: {
            oldText: { type: "string", description: "Exact existing text to replace (must match exactly once)" },
            newText: { type: "string", description: "Replacement text" }
          },
          required: ["oldText", "newText"]
        }
      }
    },
    required: ["path", "edits"]
  }
};
function createEditTool() {
  return {
    definition: EDIT_TOOL,
    recovery: {
      version: "1",
      mode: "reconcile",
      reconcile: (input, checkpoint, context) => reconcileTextFile(checkpoint, context, "Edit", input.path)
    },
    prepare: prepareEdit,
    async execute(input, context) {
      const prepared = await prepareEdit(input, context);
      return prepared.kind === "result" ? prepared.result : prepared.execute(context);
    }
  };
}
async function prepareEdit(input, context) {
  try {
    if (typeof input.path !== "string" || input.path.trim() === "" || input.path.includes("\0")) {
      throw new FilePublicationError("invalid_arguments", "Tool parameter path must be a non-empty string without NUL.");
    }
    if (!Array.isArray(input.edits) || input.edits.length === 0) {
      throw new FilePublicationError("invalid_arguments", "Tool parameter edits must be a non-empty array.");
    }
    const edits = [];
    for (const [i, item] of input.edits.entries()) {
      if (!isRecord$3(item) || typeof item.oldText !== "string" || item.oldText.length === 0 || item.oldText.includes("\0")) {
        throw new FilePublicationError("invalid_arguments", `Edit ${i + 1}: oldText must be a non-empty string without NUL.`);
      }
      if (typeof item.newText !== "string" || item.newText.includes("\0")) {
        throw new FilePublicationError("invalid_arguments", `Edit ${i + 1}: newText must be a string without NUL.`);
      }
      edits.push({ oldText: item.oldText, newText: item.newText });
    }
    checkFileCancellation(context);
    const target = resolveToolPath(input.path, context.cwd);
    const source = await observeFile(target);
    if (!source.bytes) throw new FilePublicationError("not_found", `File not found: ${input.path}`);
    if (source.bytes.includes(0)) throw new FilePublicationError("binary_file", `File contains NUL bytes: ${input.path}`);
    if (!isUtf8(source.bytes)) throw new FilePublicationError("invalid_encoding", `File must contain valid UTF-8: ${input.path}`);
    const original = source.bytes.toString("utf8");
    const matches = [];
    for (const [order, edit] of edits.entries()) {
      let count = 0;
      let index = -1;
      for (let at = original.indexOf(edit.oldText); at !== -1; at = original.indexOf(edit.oldText, at + 1)) {
        count += 1;
        index = at;
      }
      if (count !== 1) throw new FilePublicationError(
        count === 0 ? "text_not_found" : "text_not_unique",
        `Edit ${order + 1}: oldText ${count === 0 ? "was not found" : `matched ${count} locations; exactly one match is required`}: ${JSON.stringify(edit.oldText.slice(0, 200))}`
      );
      matches.push({ index, length: edit.oldText.length, edit, order });
    }
    matches.sort((left, right) => left.index - right.index);
    for (let i = 1; i < matches.length; i += 1) {
      const prev = matches[i - 1];
      const curr = matches[i];
      if (curr.index < prev.index + prev.length) throw new FilePublicationError("edits_overlap", `Overlapping edits: ${prev.order + 1} and ${curr.order + 1}`);
    }
    const parts = [];
    const lines = [];
    let offset = 0;
    let line = 1;
    let firstLine = 1;
    for (const match of matches) {
      const unchanged = original.slice(offset, match.index);
      line += (unchanged.match(/\n/g) ?? []).length;
      if (lines.length === 0) firstLine = line;
      parts.push(unchanged, match.edit.newText);
      lines.push(`  #${match.order + 1} line ${line} ${JSON.stringify(match.edit.oldText.slice(0, 200))} → ${JSON.stringify(match.edit.newText.slice(0, 200))}`);
      line += (match.edit.oldText.match(/\n/g) ?? []).length;
      offset = match.index + match.length;
    }
    parts.push(original.slice(offset));
    const plan = await planFilePublication(source, Buffer.from(parts.join(""), "utf8"), context);
    const mediaType = mediaTypeForPath(target);
    const rel = relative(context.cwd, target) || target;
    const output = `<file>${rel}</file>
Edit count: ${matches.length}
First change: line ${firstLine}
<diff>
${lines.join("\n")}
</diff>`;
    return filePublicationExecution(plan, checkpointForFilePublication(plan, mediaType), "Edit", output, mediaType);
  } catch (error) {
    return { kind: "result", result: fileErrorResult("Edit", error, "read_failed") };
  }
}
function runRipgrep(options) {
  if (options.signal?.aborted) return Promise.resolve({ code: null, stop: "cancelled", diagnostic: "" });
  return new Promise((resolve2) => {
    let child;
    try {
      child = childProcess.spawn(rgPath, ["--no-config", ...options.args], {
        cwd: options.cwd,
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"]
      });
    } catch (error) {
      resolve2({ code: null, stop: "execution_failed", diagnostic: diagnosticText(error) });
      return;
    }
    let frameParts = [];
    let frameBytes = 0;
    const stderr = [];
    let stderrBytes = 0;
    let stop;
    let failure2 = "";
    let killTimer;
    const halt = (reason) => {
      if (stop) return;
      stop = reason;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 250);
      killTimer.unref();
    };
    const abort = () => halt("cancelled");
    const failed = (error) => {
      failure2 = diagnosticText(error);
      halt("execution_failed");
    };
    child.stdout.on("data", (chunk) => {
      if (stop) return;
      let offset = 0;
      while (offset < chunk.length && !stop) {
        const end = chunk.indexOf(options.delimiter, offset);
        const next = end < 0 ? chunk.length : end;
        const length = next - offset;
        if (length > 0) frameParts.push(chunk.subarray(offset, next));
        frameBytes += length;
        if (end < 0) return;
        try {
          const frame = frameParts.length === 1 ? frameParts[0] : Buffer.concat(frameParts, frameBytes);
          options.onFrame(frame);
        } catch (error) {
          failure2 = diagnosticText(error);
          halt("invalid_output");
        }
        frameParts = [];
        frameBytes = 0;
        offset = end + 1;
      }
    });
    child.stdout.on("end", () => {
      if (!stop && frameBytes > 0) {
        failure2 = "Ripgrep returned an incomplete protocol record.";
        halt("invalid_output");
      }
    });
    child.stdout.on("error", failed);
    child.stderr.on("data", (chunk) => {
      stderr.push(chunk);
      stderrBytes += chunk.length;
    });
    child.stderr.on("error", failed);
    child.on("error", failed);
    child.once("close", (code, signal) => {
      if (killTimer) clearTimeout(killTimer);
      options.signal?.removeEventListener("abort", abort);
      const diagnostic = [failure2, Buffer.concat(stderr, stderrBytes).toString("utf8"), signal && !stop ? `Ripgrep exited on signal ${signal}.` : ""].filter(Boolean).join("\n");
      resolve2({ code, stop: options.signal?.aborted ? "cancelled" : stop, diagnostic });
    });
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
  });
}
function diagnosticText(error) {
  return error instanceof Error ? error.message : String(error);
}
const LIST_DIR_TOOL = {
  name: "list_dir",
  description: "List entries of a directory (default workspace root), sorted by name, distinguishing files and directories",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Directory to list, absolute or relative to the workspace root" },
      limit: { type: "integer", description: "Maximum entries to return (default 200, max 1000)" }
    },
    required: []
  }
};
const FIND_FILES_TOOL = {
  name: "find_files",
  description: "Find files by a case-insensitive literal substring of their relative path. Respects ignore rules and returns all matching paths.",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Substring to match against file names or relative paths" },
      path: { type: "string", description: "Search directory, absolute or relative to the workspace root (default workspace root)" }
    },
    required: ["pattern"]
  }
};
const SEARCH_CONTENT_TOOL = {
  name: "search_content",
  description: "Search text files for a literal keyword using ripgrep and workspace ignore rules. Returns all matches with paths, line numbers and full matching lines.",
  parameters: {
    type: "object",
    properties: {
      text: { type: "string", description: "Text to search for in file lines (case-insensitive substring)" },
      path: { type: "string", description: "Directory to search, absolute or relative to the workspace root (default workspace root)" },
      types: { type: "array", description: 'File extensions to include (e.g. ["ts", "md"]); all text-typed files by default', items: { type: "string", description: "extension without dot" } },
      caseSensitive: { type: "boolean", description: "Whether the match is case-sensitive (default false)" },
      contextLines: { type: "integer", description: "Lines of context around each match (non-negative safe integer, default 0)" }
    },
    required: ["text"]
  }
};
const LIST_DEFAULT_LIMIT = 200;
const LIST_MAX_LIMIT = 1e3;
function createQueryTools() {
  return [
    { definition: LIST_DIR_TOOL, recovery: { version: "1", mode: "safe" }, execute: listDir },
    { definition: FIND_FILES_TOOL, recovery: { version: "1", mode: "safe" }, execute: findFiles },
    { definition: SEARCH_CONTENT_TOOL, recovery: { version: "1", mode: "safe" }, execute: searchContent }
  ];
}
function fail(output, error) {
  return { ok: false, output, returncode: -1, truncated: false, error };
}
function toAbs(path, cwd) {
  if (!path) return cwd;
  return isAbsolute(path) ? path : resolve(cwd, path);
}
async function statOrError(target, inputPath) {
  try {
    const stats = await stat(target);
    return { stats };
  } catch {
    return { error: fail(`Path not found: ${inputPath ?? target}`, "not_found") };
  }
}
async function listDir(input, context) {
  if (input.path !== void 0 && typeof input.path !== "string") {
    return fail("Tool parameter path must be a string.", "invalid_arguments");
  }
  let limit = typeof input.limit === "number" && Number.isInteger(input.limit) ? input.limit : LIST_DEFAULT_LIMIT;
  limit = Math.min(Math.max(limit, 1), LIST_MAX_LIMIT);
  const target = toAbs(input.path, context.cwd);
  const { stats, error } = await statOrError(target, input.path);
  if (error) return error;
  if (!stats?.isDirectory()) {
    return fail(`Target is not a directory: ${input.path ?? target}`, "not_a_directory");
  }
  let entries;
  try {
    entries = await readdir(target, { withFileTypes: true });
  } catch (err) {
    return fail(`Failed to read directory: ${err instanceof Error ? err.message : String(err)}`, "read_failed");
  }
  const sorted = entries.sort((a, b) => a.name.localeCompare(b.name));
  const page = sorted.slice(0, limit);
  const rel = relative(context.cwd, target);
  const label = rel === "" ? "." : rel;
  const rows = page.map((e) => `${e.isDirectory() ? "dir " : "file "}${e.name}${e.isDirectory() ? "/" : ""}`);
  const truncNote = sorted.length > page.length ? `
Listed the first ${page.length} of ${sorted.length} items; more items were not listed.` : "";
  return {
    ok: true,
    output: `<directory>${label}</directory>
${rows.join("\n") || "(Empty directory)"}${truncNote}`,
    returncode: 0,
    truncated: sorted.length > page.length
  };
}
async function findFiles(input, context) {
  if (typeof input.pattern !== "string" || input.pattern.trim() === "") {
    return fail("Tool parameter pattern must be a non-empty string.", "invalid_arguments");
  }
  if (input.path !== void 0 && typeof input.path !== "string") {
    return fail("Tool parameter path must be a string.", "invalid_arguments");
  }
  return executeSearch(input, context, "files");
}
async function searchContent(input, context) {
  if (typeof input.text !== "string" || input.text === "") {
    return fail("Tool parameter text must be a non-empty string.", "invalid_arguments");
  }
  if (input.path !== void 0 && typeof input.path !== "string") {
    return fail("Tool parameter path must be a string.", "invalid_arguments");
  }
  return executeSearch(input, context, "content");
}
async function executeSearch(input, context, mode) {
  if (context.signal?.aborted) return { ...fail("Query cancelled; results are incomplete.", "cancelled"), truncated: true };
  const keyword = mode === "files" ? input.pattern : input.text;
  if (keyword.includes("\0") || input.path?.includes("\0")) return fail("Query parameters must contain valid text and paths.", "invalid_arguments");
  const target = toAbs(input.path, context.cwd);
  const { stats, error } = await statOrError(target, input.path);
  if (context.signal?.aborted) return { ...fail("Query cancelled; results are incomplete.", "cancelled"), truncated: true };
  if (error) return error;
  if (!stats?.isDirectory()) return fail(`Target is not a directory: ${input.path ?? target}`, "not_a_directory");
  if (mode === "content" && input.contextLines !== void 0 && (typeof input.contextLines !== "number" || !Number.isSafeInteger(input.contextLines) || input.contextLines < 0)) {
    return fail("Tool parameter contextLines must be a non-negative safe integer.", "invalid_arguments");
  }
  const contextLines = mode === "content" ? input.contextLines ?? 0 : 0;
  const types = Array.isArray(input.types) ? input.types.filter((t) => typeof t === "string").map((t) => t.toLowerCase().replace(/^\./, "")) : void 0;
  if (types?.some((type) => type.includes("\0"))) return fail("File extensions must contain valid text.", "invalid_arguments");
  const header = `<search_root>${displayPath(relative(context.cwd, target) || ".")}</search_root>`;
  const rows = [];
  const pathNeedle = keyword.toLowerCase();
  const args = ["--hidden", "--no-require-git", "--color=never"];
  if (mode === "files") args.push("--files", "--null");
  else {
    args.push("--json", "--fixed-strings", "--context", String(contextLines));
    if (input.caseSensitive !== true) args.push("--ignore-case");
    if (types?.length) {
      args.push("--type-clear", "agentquery");
      for (const type of types) args.push("--type-add", `agentquery:${extensionGlob(type)}`);
      args.push("--type", "agentquery");
    }
    args.push("--regexp", keyword);
  }
  for (const directory of SNAPSHOT_IGNORED_DIRECTORIES) args.push("--glob", `!**/${directory}/**`);
  args.push("--", ".");
  let lastMatch;
  let pending = [];
  const outcome = mode === "content" && (keyword.includes("\n") || types?.length === 0) ? { code: 1, diagnostic: "" } : await runRipgrep({
    args,
    cwd: target,
    signal: context.signal,
    delimiter: mode === "files" ? 0 : 10,
    onFrame(frame) {
      if (mode === "files") {
        const file2 = normalizePath(frame.toString("utf8"));
        if (!file2.toLowerCase().includes(pathNeedle)) return;
        rows.push(displayPath(file2));
        return;
      }
      const event = JSON.parse(frame.toString("utf8"));
      if (event.type === "begin" || event.type === "end") {
        lastMatch = void 0;
        pending = [];
        return;
      }
      if (event.type === "summary") return;
      if (event.type !== "match" && event.type !== "context") throw new Error("Unexpected ripgrep event.");
      const file = normalizePath(decodeField(event.data.path));
      if (types && !types.includes(extname(file).toLowerCase().replace(/^\./, ""))) return;
      const line = event.data.line_number;
      if (typeof line !== "number" || !Number.isSafeInteger(line) || line < 1) throw new Error("Invalid ripgrep line number.");
      const content = decodeField(event.data.lines).replace(/\r?\n$/, "");
      const row = `${displayPath(file)}:${line}: ${content}`;
      if (event.type === "context") {
        if (lastMatch !== void 0 && line <= lastMatch + contextLines) {
          rows.push(row);
          return;
        }
        pending.push(row);
        if (pending.length > contextLines) pending.shift();
        return;
      }
      for (const contextRow of pending) rows.push(contextRow);
      pending = [];
      lastMatch = line;
      rows.push(row);
    }
  });
  if (mode === "files") rows.sort();
  return searchResult(header, rows, outcome, mode);
}
function searchResult(header, rows, outcome, mode) {
  const reasons = {
    cancelled: "Query cancelled; results are incomplete.",
    invalid_output: "Ripgrep returned invalid output; results are incomplete.",
    execution_failed: "Ripgrep execution failed; results are incomplete."
  };
  const abnormalExit = outcome.code !== null && outcome.code !== 0 && outcome.code !== 1;
  const failed = Boolean(outcome.stop) || outcome.code !== 0 && outcome.code !== 1;
  const notes = [
    outcome.stop ? reasons[outcome.stop] : failed ? `Ripgrep exited with code ${outcome.code ?? "unknown"}; results are incomplete.` : "",
    outcome.stop && abnormalExit ? `Ripgrep exited with code ${outcome.code}; results are incomplete.` : "",
    outcome.diagnostic
  ].filter(Boolean);
  const empty = failed ? "(Partial results: 0 rows retained)" : mode === "files" ? "(No matching files)" : "(No matching content)";
  return {
    ok: !failed,
    output: [header, rows.join("\n") || empty, ...notes].join("\n"),
    returncode: failed ? abnormalExit ? outcome.code : -1 : 0,
    truncated: failed,
    ...failed ? { error: outcome.stop === "cancelled" ? "cancelled" : outcome.stop === "invalid_output" ? "invalid_output" : "execution_failed" } : {}
  };
}
function decodeField(field) {
  if (typeof field !== "object" || field === null) throw new Error("Invalid ripgrep text field.");
  if ("text" in field && typeof field.text === "string") return field.text;
  if ("bytes" in field && typeof field.bytes === "string") return Buffer.from(field.bytes, "base64").toString("utf8");
  throw new Error("Invalid ripgrep text encoding.");
}
function normalizePath(file) {
  return file.split(sep).join("/").replace(/^\.\//, "");
}
function displayPath(file) {
  return /[\r\n\x00-\x1f]/.test(file) ? JSON.stringify(file) : file;
}
function escapeGlob(value) {
  return value.replace(/[\\*?\[\]{}]/g, "\\$&");
}
function extensionGlob(extension) {
  if (extension === "" || /[^\x00-\x7f]/.test(extension)) return "*";
  return `*.${escapeGlob(extension).replace(/[a-z]/g, (letter) => `[${letter}${letter.toUpperCase()}]`)}`;
}
function createToolRegistry(ops) {
  const tools = [
    createBashTool(ops),
    createReadTool(),
    createWriteTool(),
    createEditTool(),
    ...createQueryTools()
  ];
  const registry = /* @__PURE__ */ new Map();
  for (const tool of tools) {
    if (registry.has(tool.definition.name)) {
      throw new Error(`Duplicate tool registration: ${tool.definition.name}`);
    }
    registry.set(tool.definition.name, tool);
  }
  return registry;
}
const MAX_OPERATIONS = 32;
const MAX_POINTS = 2048;
const MAX_TEXT_LENGTH = 2e4;
const MAX_ABSOLUTE_COORDINATE = 1e6;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_TOTAL_IMAGE_BYTES = 8 * 1024 * 1024;
const ELEMENT_TYPES = /* @__PURE__ */ new Set(["rectangle", "ellipse", "diamond", "line", "arrow", "freedraw", "text", "image"]);
const DIRECTIONS = /* @__PURE__ */ new Set(["front", "back", "forward", "backward"]);
const CREATE_FIELDS = /* @__PURE__ */ new Set(["type", "x", "y", "width", "height", "angle", "text", "points", "fileId", "attachmentId", "startElementId", "endElementId"]);
const CHANGE_FIELDS = /* @__PURE__ */ new Set(["x", "y", "width", "height", "angle", "text", "points", "scale", "crop"]);
const CANVAS_EDIT_TOOL = {
  name: "canvas_edit",
  description: "Create elements from the user's instructions. To update, delete, duplicate, group, lock, or reorder existing elements, use the elements explicitly supplied through Use selection. Operations apply to the live scene; targets must come from that reference or an earlier successful canvas_edit result. A conflict returns the affected current elements. Use one call for related operations. The editor applies changes to its live scene and a successful result confirms project persistence. Canvas scene files are managed by the application's save pipeline. An outcome_unknown error means an edit may already have applied; ask the user to verify the Canvas and provide a fresh reference before retrying.",
  parameters: {
    type: "object",
    properties: {
      operations: {
        type: "array",
        description: "One to 32 ordered Canvas operations. create uses element; update uses id and changes; delete/duplicate/reorder/flip/setLocked use id; group/ungroup use ids.",
        items: {
          type: "object",
          description: "A Canvas operation",
          properties: {
            action: { type: "string", description: "Operation kind", enum: ["create", "update", "delete", "duplicate", "reorder", "flip", "setLocked", "group", "ungroup"] },
            id: { type: "string", description: "Existing element ID from Use selection or a successful prior edit" },
            ids: { type: "array", description: "Existing element IDs for group or ungroup", items: { type: "string", description: "Element ID" } },
            element: {
              type: "object",
              description: "New element in scene coordinates. Shape types: rectangle, ellipse, diamond, line, arrow, freedraw, text, image. An image reuses a referenced fileId or imports a user-uploaded image attachment for this run.",
              properties: {
                type: { type: "string", description: "Element type", enum: [...ELEMENT_TYPES] },
                x: { type: "number", description: "Scene X" },
                y: { type: "number", description: "Scene Y" },
                width: { type: "number", description: "Width" },
                height: { type: "number", description: "Height" },
                angle: { type: "number", description: "Rotation in radians" },
                text: { type: "string", description: "Text element content" },
                points: { type: "array", description: "Local coordinates for a line, arrow, or freehand stroke", items: { type: "array", description: "A two-number point", items: { type: "number", description: "Coordinate" } } },
                fileId: { type: "string", description: "Existing image asset ID from the current Canvas" },
                attachmentId: { type: "string", description: "Image attachment ID uploaded by the user for this Run" },
                startElementId: { type: "string", description: "Use selection element ID to bind the start of a new arrow" },
                endElementId: { type: "string", description: "Use selection element ID to bind the end of a new arrow" }
              },
              required: ["type", "x", "y"]
            },
            changes: {
              type: "object",
              description: "Fields to change on an existing element; untouched fields retain the live scene values",
              properties: {
                x: { type: "number", description: "Scene X" },
                y: { type: "number", description: "Scene Y" },
                width: { type: "number", description: "Width" },
                height: { type: "number", description: "Height" },
                angle: { type: "number", description: "Rotation in radians" },
                text: { type: "string", description: "Text content" },
                points: { type: "array", description: "Local line or stroke coordinates", items: { type: "array", description: "A two-number point", items: { type: "number", description: "Coordinate" } } },
                scale: { type: "array", description: "Image scale factors for flipping", items: { type: "number", description: "Scale factor" } },
                crop: { type: "object", description: "Image crop in natural pixel coordinates", properties: { x: { type: "number", description: "Crop X" }, y: { type: "number", description: "Crop Y" }, width: { type: "number", description: "Crop width" }, height: { type: "number", description: "Crop height" }, naturalWidth: { type: "number", description: "Source width" }, naturalHeight: { type: "number", description: "Source height" } }, required: ["x", "y", "width", "height", "naturalWidth", "naturalHeight"] }
              },
              required: []
            },
            direction: { type: "string", description: "Reorder direction", enum: [...DIRECTIONS] },
            axis: { type: "string", description: "Image flip axis", enum: ["horizontal", "vertical"] },
            locked: { type: "boolean", description: "Lock state" },
            offsetX: { type: "number", description: "Duplicate X offset" },
            offsetY: { type: "number", description: "Duplicate Y offset" }
          },
          required: ["action"]
        }
      }
    },
    required: ["operations"]
  }
};
function createCanvasEditTool(scope) {
  const baselines = /* @__PURE__ */ new Map();
  const authorizedIds = /* @__PURE__ */ new Set();
  for (const element of scope.sourceElements) {
    if (typeof element.id !== "string" || !element.id) throw new Error("The canvas selection contains an invalid element ID.");
    authorizedIds.add(element.id);
    baselines.set(element.id, structuredClone(element));
  }
  return {
    definition: CANVAS_EDIT_TOOL,
    recovery: { version: "1", mode: "never", resumePlanned: false },
    async execute(input, context) {
      if (context.signal?.aborted) return failure("The run stopped before the canvas edit began.", "cancelled");
      const operations = parseOperations(input.operations);
      if (operations instanceof Error) return failure(operations.message, "invalid_arguments");
      const availableFileIds = new Set([...baselines.values()].flatMap((element) => typeof element.fileId === "string" ? [element.fileId] : []));
      const imageAttachments = new Map((scope.imageAttachments ?? []).filter((item) => item.mediaType.startsWith("image/")).map((item) => [item.attachmentId, item]));
      const imageFilesByAttachment = /* @__PURE__ */ new Map();
      let totalImageBytes = 0;
      for (const operation of operations) {
        if (operation.action === "create") {
          for (const id of [operation.element.startElementId, operation.element.endElementId]) {
            if (id && !baselines.has(id)) {
              return failure(`Arrow binding target ${id} is not in this run's Canvas selection or an earlier edit result.`, "unauthorized_element");
            }
          }
        }
        if (operation.action === "create" && operation.element.type === "image") {
          if (operation.element.fileId && !availableFileIds.has(operation.element.fileId)) {
            return failure("New Canvas images can only reuse an image included in this run's Canvas selection.", "unauthorized_image");
          }
          if (operation.element.attachmentId) {
            const attachment = imageAttachments.get(operation.element.attachmentId);
            if (!attachment) return failure("The image attachment was not uploaded for this Run.", "unauthorized_image");
            if (attachment.byteSize > MAX_IMAGE_BYTES) return failure("Canvas image attachments must be 4 MB or smaller.", "image_too_large");
            if (imageFilesByAttachment.has(attachment.attachmentId)) continue;
            try {
              const bytes = await readFile(attachment.path);
              if (bytes.byteLength > MAX_IMAGE_BYTES || bytes.byteLength !== attachment.byteSize) {
                return failure("The image attachment changed or exceeds the Canvas size limit.", "image_too_large");
              }
              totalImageBytes += bytes.byteLength;
              if (totalImageBytes > MAX_TOTAL_IMAGE_BYTES) {
                return failure("Canvas image imports in one edit are limited to 8 MB total.", "image_batch_too_large");
              }
              imageFilesByAttachment.set(attachment.attachmentId, {
                attachmentId: attachment.attachmentId,
                fileId: randomUUID(),
                mimeType: attachment.mediaType,
                dataURL: `data:${attachment.mediaType};base64,${bytes.toString("base64")}`,
                created: Date.now()
              });
            } catch {
              return failure("The image attachment could not be read. Upload it again.", "attachment_unavailable");
            }
          }
          if (!operation.element.fileId && !operation.element.attachmentId) {
            return failure("An image element needs a referenced Canvas file or a user image attachment.", "invalid_image_source");
          }
        }
        const ids = operation.action === "create" ? [] : "id" in operation ? [operation.id] : "ids" in operation ? operation.ids : [];
        for (const id of ids) {
          const baseline = baselines.get(id);
          if (!baseline || baseline.isDeleted === true || baseline.deleted === true) {
            return failure(`Element ${id} is not in this run's Canvas selection or a prior edit result.`, "unauthorized_element");
          }
        }
      }
      let result;
      try {
        result = await scope.execute(scope.ownerWebContentsId, {
          runId: scope.runId,
          projectId: scope.projectId,
          operations,
          sourceElements: [...baselines.values()].map((element) => structuredClone(element)),
          ...imageFilesByAttachment.size ? { imageFiles: [...imageFilesByAttachment.values()] } : {}
        }, context.signal);
      } catch (error) {
        const code = isRecord$2(error) && typeof error.code === "string" ? error.code : "canvas_unavailable";
        return failure(error instanceof Error ? error.message : String(error), code);
      }
      const affected = result.appliedElements ?? [];
      const createdIdSet = new Set(result.createdIds ?? []);
      const visibleAffected = affected.filter((element) => typeof element.id === "string" && (authorizedIds.has(element.id) || createdIdSet.has(element.id)));
      for (const element of affected) {
        if (typeof element.id === "string" && authorizedIds.has(element.id)) {
          baselines.set(element.id, structuredClone(element));
        }
      }
      for (const id of result.createdIds ?? []) {
        authorizedIds.add(id);
        const created = affected.find((element) => element.id === id);
        if (created) baselines.set(id, structuredClone(created));
      }
      for (const conflict of result.conflicts ?? []) {
        if (conflict.current && baselines.has(conflict.id)) baselines.set(conflict.id, structuredClone(conflict.current));
      }
      if (!result.ok) {
        const payload = {
          status: result.conflicts?.length || result.error === "persistence_conflict" ? "conflict" : "failed",
          error: result.error,
          conflicts: (result.conflicts ?? []).map((conflict) => ({
            id: conflict.id,
            reason: conflict.reason,
            ...conflict.current ? { current: compactElement(conflict.current) } : {}
          })),
          ...visibleAffected.length ? { appliedInMemory: true, totalAffected: visibleAffected.length, elements: visibleAffected.slice(0, 64).map(compactElement) } : {},
          ...result.createdIds?.length ? { createdIds: result.createdIds } : {}
        };
        const error = result.conflicts?.length ? "canvas_conflict" : result.error === "persistence_conflict" || result.error === "persistence_failed" ? result.error : "canvas_edit_failed";
        return failure(JSON.stringify(payload), error);
      }
      const compactElements = visibleAffected.map(compactElement);
      return {
        ok: true,
        output: JSON.stringify({ status: "applied", createdIds: result.createdIds ?? [], totalAffected: compactElements.length, elements: compactElements.slice(0, 64) }),
        returncode: 0,
        truncated: false
      };
    }
  };
}
function parseOperations(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_OPERATIONS) {
    return new Error(`operations must contain between 1 and ${MAX_OPERATIONS} items.`);
  }
  const operations = [];
  for (const [index, raw] of value.entries()) {
    if (!isRecord$2(raw) || typeof raw.action !== "string") return new Error(`Operation ${index + 1} has no valid action.`);
    const action = raw.action;
    if (action === "create") {
      if (!hasOnlyFields(raw, /* @__PURE__ */ new Set(["action", "element"])) || !isRecord$2(raw.element) || !hasOnlyFields(raw.element, CREATE_FIELDS) || !ELEMENT_TYPES.has(raw.element.type) || !isCoordinate(raw.element.x) || !isCoordinate(raw.element.y) || !validFields(raw.element, true) || (raw.element.startElementId !== void 0 || raw.element.endElementId !== void 0) && raw.element.type !== "arrow" || raw.element.startElementId !== void 0 && !isId(raw.element.startElementId) || raw.element.endElementId !== void 0 && !isId(raw.element.endElementId) || raw.element.type === "image" && Boolean(raw.element.fileId) === Boolean(raw.element.attachmentId) || raw.element.type !== "image" && (raw.element.fileId !== void 0 || raw.element.attachmentId !== void 0)) {
        return new Error(`Operation ${index + 1} has an invalid element.`);
      }
    } else if (action === "update") {
      if (!hasOnlyFields(raw, /* @__PURE__ */ new Set(["action", "id", "changes"])) || !isId(raw.id) || !isRecord$2(raw.changes) || Object.keys(raw.changes).length === 0 || !hasOnlyFields(raw.changes, CHANGE_FIELDS) || !validFields(raw.changes, false)) {
        return new Error(`Operation ${index + 1} has an invalid update.`);
      }
    } else if (action === "delete") {
      if (!hasOnlyFields(raw, /* @__PURE__ */ new Set(["action", "id"])) || !isId(raw.id)) return new Error(`Operation ${index + 1} has an invalid element ID.`);
    } else if (action === "duplicate") {
      if (!hasOnlyFields(raw, /* @__PURE__ */ new Set(["action", "id", "offsetX", "offsetY"])) || !isId(raw.id) || raw.offsetX !== void 0 && !isCoordinate(raw.offsetX) || raw.offsetY !== void 0 && !isCoordinate(raw.offsetY)) return new Error(`Operation ${index + 1} has an invalid duplicate.`);
    } else if (action === "reorder") {
      if (!hasOnlyFields(raw, /* @__PURE__ */ new Set(["action", "id", "direction"])) || !isId(raw.id) || !DIRECTIONS.has(raw.direction)) return new Error(`Operation ${index + 1} has an invalid reorder.`);
    } else if (action === "flip") {
      if (!hasOnlyFields(raw, /* @__PURE__ */ new Set(["action", "id", "axis"])) || !isId(raw.id) || !["horizontal", "vertical"].includes(raw.axis)) return new Error(`Operation ${index + 1} has an invalid flip.`);
    } else if (action === "setLocked") {
      if (!hasOnlyFields(raw, /* @__PURE__ */ new Set(["action", "id", "locked"])) || !isId(raw.id) || typeof raw.locked !== "boolean") return new Error(`Operation ${index + 1} has an invalid lock state.`);
    } else if (action === "group" || action === "ungroup") {
      if (!hasOnlyFields(raw, /* @__PURE__ */ new Set(["action", "ids"])) || !Array.isArray(raw.ids) || raw.ids.length < (action === "group" ? 2 : 1) || raw.ids.length > MAX_OPERATIONS || !raw.ids.every(isId) || new Set(raw.ids).size !== raw.ids.length) {
        return new Error(`Operation ${index + 1} has invalid group IDs.`);
      }
    } else {
      return new Error(`Operation ${index + 1} has an unknown action.`);
    }
    operations.push(raw);
  }
  return operations;
}
function validFields(fields, isCreate) {
  for (const [key, value] of Object.entries(fields)) {
    if (["x", "y", "width", "height", "angle"].includes(key)) {
      if (!isCoordinate(value) || (key === "width" || key === "height") && value < 0) return false;
    } else if (key === "text") {
      if (typeof value !== "string" || value.length > MAX_TEXT_LENGTH) return false;
    } else if (key === "points") {
      if (!Array.isArray(value) || value.length === 0 || value.length > MAX_POINTS || !value.every((point) => Array.isArray(point) && point.length === 2 && point.every(isCoordinate))) return false;
    } else if (key === "fileId") {
      if (!isCreate || !isId(value)) return false;
    } else if (key === "attachmentId") {
      if (!isCreate || !isId(value)) return false;
    } else if (key === "scale") {
      if (!Array.isArray(value) || value.length !== 2 || !value.every((scale) => typeof scale === "number" && Number.isFinite(scale) && Math.abs(scale) <= 1 && scale !== 0)) return false;
    } else if (key === "crop") {
      if (!isRecord$2(value) || !hasOnlyFields(value, /* @__PURE__ */ new Set(["x", "y", "width", "height", "naturalWidth", "naturalHeight"])) || !["x", "y", "width", "height", "naturalWidth", "naturalHeight"].every((field) => isCoordinate(value[field]))) return false;
    }
  }
  return true;
}
function hasOnlyFields(value, allowed) {
  return Object.keys(value).every((key) => allowed.has(key));
}
function isCoordinate(value) {
  return typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= MAX_ABSOLUTE_COORDINATE;
}
function isId(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 256;
}
function isRecord$2(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function failure(output, error) {
  return { ok: false, output, returncode: -1, truncated: false, error };
}
function compactElement(element) {
  return {
    id: element.id,
    type: element.type,
    x: element.x,
    y: element.y,
    width: element.width,
    height: element.height,
    angle: element.angle,
    version: element.version,
    versionNonce: element.versionNonce,
    isDeleted: element.isDeleted,
    ...typeof element.text === "string" ? { text: element.text.slice(0, 2e3) } : {},
    ...Array.isArray(element.points) ? { points: element.points.slice(0, 128) } : {},
    ...Array.isArray(element.scale) ? { scale: element.scale } : {},
    ...element.crop && typeof element.crop === "object" ? { crop: element.crop } : {}
  };
}
function toPublicToolResult(result) {
  return {
    ok: result.ok,
    output: result.output,
    returncode: result.returncode,
    truncated: result.truncated,
    error: result.error
  };
}
function readPublicToolResult(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return void 0;
  const result = value;
  if (typeof result.ok !== "boolean" || typeof result.output !== "string" || typeof result.returncode !== "number" || !Number.isSafeInteger(result.returncode) || typeof result.truncated !== "boolean" || result.error !== void 0 && typeof result.error !== "string") return void 0;
  return toPublicToolResult({
    ok: result.ok,
    output: result.output,
    returncode: result.returncode,
    truncated: result.truncated,
    error: result.error
  });
}
const MAX_PENDING_INPUTS = 32;
const MAX_INPUT_CHARS = 2e4;
class RunInputInbox {
  constructor(runId, projectId, recorder) {
    this.runId = runId;
    this.projectId = projectId;
    this.recorder = recorder;
  }
  runId;
  projectId;
  recorder;
  accepting = true;
  inFlight = /* @__PURE__ */ new Set();
  requests = /* @__PURE__ */ new Map();
  queuedIds = /* @__PURE__ */ new Set();
  queued = [];
  closing = null;
  async accept(inputId, content) {
    const normalized = content.trim();
    if (!normalized || normalized.length > MAX_INPUT_CHARS) {
      throw new Error(`Steering text must contain between 1 and ${MAX_INPUT_CHARS} characters.`);
    }
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(inputId)) throw new Error("The steering input ID is invalid.");
    const previous = this.requests.get(inputId);
    if (previous) {
      if (previous.content !== normalized) throw new Error("The steering input ID belongs to different text.");
      return previous.result;
    }
    if (!this.accepting) throw new Error("The current run is finishing. Send the text as a new task.");
    if (this.queued.length + this.inFlight.size >= MAX_PENDING_INPUTS) {
      throw new Error("The current run has reached its pending input limit.");
    }
    const result = this.recorder.acceptRunInput({ inputId, runId: this.runId, content: normalized }).then((record2) => {
      if (record2.state === "accepted" && !this.queuedIds.has(inputId)) {
        this.queued.push(record2);
        this.queuedIds.add(inputId);
      }
      return record2;
    });
    this.requests.set(inputId, { content: normalized, result });
    this.inFlight.add(result);
    void result.then(
      () => {
        this.inFlight.delete(result);
      },
      () => {
        this.inFlight.delete(result);
        this.requests.delete(inputId);
      }
    );
    return result;
  }
  stopAdmission() {
    this.accepting = false;
  }
  async takePending() {
    await this.settleAdmissions();
    return this.takeQueued();
  }
  async takePendingOrSeal() {
    await this.settleAdmissions();
    const batch = this.takeQueued();
    if (batch.length === 0) this.accepting = false;
    return batch;
  }
  closeAndAbandon(reason) {
    if (this.closing) return this.closing;
    this.accepting = false;
    this.closing = (async () => {
      await this.settleAdmissions();
      this.queued = [];
      this.queuedIds.clear();
      const entries = await this.recorder.abandonRunInputs(this.runId, reason);
      return entries.map((entry) => entry.id);
    })();
    return this.closing;
  }
  async settleAdmissions() {
    while (this.inFlight.size > 0) await Promise.allSettled([...this.inFlight]);
  }
  takeQueued() {
    const batch = this.queued.sort((left, right) => left.acceptOrder - right.acceptOrder);
    this.queued = [];
    this.queuedIds.clear();
    return batch.map(({ inputId, content }) => ({ inputId, content }));
  }
}
const SYSTEM_PROMPT = "You are a coding agent. Use the available tools when needed, then provide a concise final answer.";
const CANVAS_SYSTEM_PROMPT = `${SYSTEM_PROMPT}
Live Canvas edits use canvas_edit. Submit element operations to the current editor, which owns the live scene and project persistence. Existing targets come from Use selection or successful Canvas edits in this run. A persistence_conflict result pauses Canvas saving; ask the user to resolve it using the Canvas controls. File tools serve project files and user-requested exports.`;
const MAX_CANVAS_EDIT_BASE_ELEMENTS = 1e3;
class AgentRunner {
  constructor(registerArtifacts, canvasEdit) {
    this.registerArtifacts = registerArtifacts;
    this.canvasEdit = canvasEdit;
  }
  registerArtifacts;
  canvasEdit;
  controller = new AbortController();
  active = false;
  activeRun = null;
  idleResolvers = /* @__PURE__ */ new Set();
  // Filesystem capabilities belong to the runtime, while cwd and projectId
  // identify the current run's execution and history scopes independently.
  baseTools = createToolRegistry(createLocalBashOps());
  get isActive() {
    return this.active;
  }
  waitForIdle() {
    if (!this.active) return Promise.resolve();
    return new Promise((resolve2) => this.idleResolvers.add(resolve2));
  }
  start(req, emit) {
    if (this.active) throw new Error("A run is already in progress. Stop the current task first.");
    const runId = req.runId ?? randomUUID();
    if (req.projectId === void 0) {
      throw new Error("The run request is missing a project scope.");
    }
    const recorder = req.historyRecorder;
    const tools = new Map(this.baseTools);
    if (this.canvasEdit && req.ownerWebContentsId !== void 0 && ((req.canvasContexts?.length ?? 0) > 0 || this.canvasEdit.enableCreateWithoutSelection)) {
      const sourceElements = selectedCanvasElements(req.canvasContexts ?? [], req.projectId);
      tools.set("canvas_edit", createCanvasEditTool({
        runId,
        projectId: req.projectId,
        ownerWebContentsId: req.ownerWebContentsId,
        sourceElements,
        imageAttachments: req.attachments,
        execute: this.canvasEdit.execute
      }));
    }
    this.controller = new AbortController();
    this.active = true;
    const inbox = new RunInputInbox(runId, req.projectId, recorder);
    const activeRun = { runId, projectId: req.projectId, ownerWebContentsId: req.ownerWebContentsId, inbox, recorder };
    this.activeRun = activeRun;
    const emitOnce = /* @__PURE__ */ (() => {
      let completed = false;
      return (event) => {
        if (event.type === "runCompleted") {
          if (completed) return;
          completed = true;
          this.markIdle();
        }
        emit(event);
      };
    })();
    const events = {
      onRunStart: (ctx) => emitOnce({ type: "runStarted", ...ctx }),
      onTurnStart: (ctx) => emitOnce({ type: "turnStarted", ...ctx }),
      onReasoningDelta: (delta, ctx) => emitOnce({ type: "reasoningDelta", ...ctx, delta }),
      onAssistantDelta: (delta, ctx) => emitOnce({ type: "assistantDelta", ...ctx, delta }),
      onAssistantCompleted: (response2, ctx) => emitOnce({ type: "assistantCompleted", ...ctx, content: response2.content, toolCalls: response2.toolCalls, stopReason: response2.stopReason }),
      onToolStart: (call, ctx) => emitOnce({ type: "toolStarted", runId: ctx.runId, turnId: ctx.turnId, toolCallId: call.id, name: call.name, input: call.input }),
      onToolCompleted: (call, result, ctx) => {
        emitOnce({
          type: "toolCompleted",
          runId: ctx.runId,
          turnId: ctx.turnId,
          toolCallId: call.id,
          name: call.name,
          result: toPublicToolResult(result)
        });
        if (result.artifacts?.length && this.registerArtifacts) {
          const files = this.registerArtifacts(ctx.runId, req.cwd, result.artifacts, req.projectId);
          for (const file of files) emitOnce({ type: "outputFileRegistered", runId: ctx.runId, file });
        }
      },
      onTurnRetrying: (ctx) => emitOnce({ type: "turnRetrying", ...ctx }),
      onTurnCompleted: (ctx) => emitOnce({ type: "turnCompleted", ...ctx }),
      onInputsApplied: (result) => emitOnce({ type: "inputsApplied", ...result }),
      onRunCompleted: (result) => emitOnce({ type: "runCompleted", ...result })
    };
    const modelConfig = {
      provider: "openai",
      model: req.modelId,
      openai: {
        baseURL: req.baseURL,
        apiKeyProvider: req.getApiKey,
        reasoningField: req.baseURL?.toLowerCase().includes("deepseek") ? "reasoning_content" : void 0
      }
    };
    setImmediate(() => {
      void run(req.task, modelConfig, {
        runId,
        systemPrompt: tools.has("canvas_edit") ? CANVAS_SYSTEM_PROMPT : SYSTEM_PROMPT,
        cwd: req.cwd,
        tools,
        signal: this.controller.signal,
        recorder,
        initialUserEntryId: req.initialUserEntryId,
        initialUserCreatedAt: req.initialUserCreatedAt,
        steeringInbox: inbox,
        cancellationBarrier: () => activeRun.cancellation ?? Promise.resolve(),
        runScopedContext: [
          ...req.runScopedContext ?? [],
          ...req.canvasContexts?.map(toModelMessage) ?? []
        ]
      }, events).catch(async (error) => {
        let unappliedInputIds = [];
        try {
          unappliedInputIds = await inbox.closeAndAbandon("failed");
        } catch {
        }
        emitOnce({ type: "runCompleted", runId, status: "failed", turnCount: 0, error: { kind: "runtime", message: error instanceof Error ? error.message : String(error) }, ...unappliedInputIds.length ? { unappliedInputIds } : {} });
      });
    });
    return { runId, stop: () => this.stop() };
  }
  async steer(request, senderWebContentsId) {
    const active = this.activeRun;
    if (!this.active || !active || active.runId !== request.runId || active.projectId !== request.projectId) {
      throw new Error("The selected run has finished or belongs to another project.");
    }
    if (active.ownerWebContentsId !== void 0 && active.ownerWebContentsId !== senderWebContentsId) {
      throw new Error("The selected run belongs to another window.");
    }
    return active.inbox.accept(request.inputId, request.task);
  }
  stop(senderWebContentsId) {
    if (senderWebContentsId !== void 0 && this.activeRun?.ownerWebContentsId !== void 0 && this.activeRun.ownerWebContentsId !== senderWebContentsId) return;
    if (this.active) {
      const active = this.activeRun;
      active?.inbox.stopAdmission();
      if (active && !active.cancellation) {
        try {
          active.cancellation = active.recorder.requestRunCancellation(active.runId);
        } catch (error) {
          active.cancellation = Promise.reject(error);
        }
        void active.cancellation.catch(() => void 0);
      }
      this.controller.abort();
    }
  }
  markIdle() {
    if (!this.active) return;
    this.active = false;
    this.activeRun = null;
    for (const resolve2 of this.idleResolvers) resolve2();
    this.idleResolvers.clear();
  }
}
function selectedCanvasElements(contexts, projectId) {
  const elements = /* @__PURE__ */ new Map();
  for (const context of contexts) {
    if (context.descriptor.projectId !== projectId) throw new Error("The Canvas selection belongs to another project.");
    const parsed = JSON.parse(context.text);
    if (!Array.isArray(parsed.elements)) throw new Error("The Canvas selection is invalid.");
    for (const element of parsed.elements) {
      if (!element || typeof element !== "object" || Array.isArray(element) || typeof element.id !== "string") {
        throw new Error("The Canvas selection contains an invalid element.");
      }
      elements.set(element.id, element);
      if (elements.size > MAX_CANVAS_EDIT_BASE_ELEMENTS) {
        throw new Error(`Canvas Edit supports at most ${MAX_CANVAS_EDIT_BASE_ELEMENTS} referenced elements per Run.`);
      }
    }
  }
  return [...elements.values()];
}
function toModelMessage(context) {
  return {
    role: "user",
    content: `Canvas selection JSON for this run:
${context.text}`,
    ...context.visual ? { media: { mediaType: context.visual.mediaType, dataUrl: context.visual.dataURL } } : {}
  };
}
const DEFAULT_HISTORY_PAGE_LIMIT = 100;
const MAX_HISTORY_PAGE_LIMIT = 200;
class HistoryError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
    this.name = "HistoryError";
  }
  code;
}
function normalizePageRequest(request) {
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    throw new HistoryError("The history page request format is invalid.", "invalid_request");
  }
  const candidate = request;
  const cursor = candidate.cursor === void 0 ? null : candidate.cursor;
  if (cursor !== null && (typeof cursor !== "string" || !/^[1-9]\d*$/.test(cursor))) {
    throw new HistoryError("The history page cursor is invalid.", "invalid_request");
  }
  const beforeOrder = cursor === null ? null : Number(cursor);
  if (beforeOrder !== null && !Number.isSafeInteger(beforeOrder)) {
    throw new HistoryError("The history page cursor is outside the safe range.", "invalid_request");
  }
  const limit = candidate.limit ?? DEFAULT_HISTORY_PAGE_LIMIT;
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > MAX_HISTORY_PAGE_LIMIT) {
    throw new HistoryError(`The history page size must be between 1 and ${MAX_HISTORY_PAGE_LIMIT}.`, "invalid_request");
  }
  return { beforeOrder, limit };
}
function toHistoryEntry(entry, outcome) {
  const toolResult = outcome === void 0 ? void 0 : readPublicToolResult(outcome);
  if (outcome !== void 0 && !toolResult) {
    throw new HistoryError(`Stored tool outcome is invalid for entry ${entry.id}.`, "storage");
  }
  return {
    entryId: entry.id,
    entryOrder: entry.entryOrder,
    projectId: entry.projectId,
    type: entry.type,
    status: entry.status,
    runId: entry.runId,
    turnId: entry.turnId,
    toolCallId: entry.toolCallId,
    revision: entry.revision,
    payload: entry.payload,
    createdAt: entry.createdAt,
    completedAt: entry.completedAt,
    durationMs: entry.durationMs,
    ...toolResult ? { toolResult } : {}
  };
}
class HistoryService {
  constructor(getActiveScope, repository) {
    this.getActiveScope = getActiveScope;
    this.repository = repository;
  }
  getActiveScope;
  repository;
  inFlight = /* @__PURE__ */ new Map();
  async loadPage(request) {
    const normalized = normalizePageRequest(request);
    const scope = this.getActiveScope();
    const scopeKey = scope ?? "unprojected";
    const requestKey = `${scopeKey}:${normalized.beforeOrder ?? "latest"}:${normalized.limit}`;
    const existing = this.inFlight.get(requestKey);
    if (existing) return existing;
    const operation = this.readPage(scope, normalized).finally(() => {
      if (this.inFlight.get(requestKey) === operation) this.inFlight.delete(requestKey);
    });
    this.inFlight.set(requestKey, operation);
    return operation;
  }
  async readPage(scope, request) {
    const fetchLimit = request.limit + 1;
    const descendingEntries = request.beforeOrder === null ? await this.repository.listLatestEntries(scope, fetchLimit) : await this.repository.listEntriesBefore(scope, request.beforeOrder, fetchLimit);
    const hasMore = descendingEntries.length > request.limit;
    const pageDescending = hasMore ? descendingEntries.slice(0, request.limit) : descendingEntries;
    const entries = pageDescending.slice().reverse();
    const nextCursor = hasMore && entries.length > 0 ? String(entries[0].entryOrder) : null;
    if (nextCursor !== null && request.beforeOrder !== null && Number(nextCursor) >= request.beforeOrder) {
      throw new HistoryError("The history page cursor did not advance to older records.", "storage");
    }
    const toolEntryIds = entries.filter((entry) => entry.type === "tool_result").map((entry) => entry.id);
    const outcomes = toolEntryIds.length > 0 ? await this.repository.getToolOutcomesForEntries(scope, toolEntryIds) : /* @__PURE__ */ new Map();
    const latest = await this.repository.listLatestEntries(scope, 1);
    return {
      projectId: scope,
      entries: entries.map((entry) => toHistoryEntry(entry, outcomes.get(entry.id))),
      nextCursor,
      hasMore,
      snapshotOrder: latest[0]?.entryOrder ?? 0
    };
  }
}
const SCAN_POLICY_VERSION = "tree-v2-prioritized-depth2-dir20-nodes180";
const MAX_CACHE_AGE_MS = 3e4;
const MAX_DEPTH = 2;
const MAX_ENTRIES_PER_DIRECTORY = 20;
const MAX_TREE_NODES = 180;
const MAX_PROJECT_CONTEXT_CHARS = 6e3;
const IGNORED_DIRECTORY_NAMES = /* @__PURE__ */ new Set([
  ".git",
  ".hg",
  ".svn",
  ".next",
  ".pytest_cache",
  ".ruff_cache",
  ".mypy_cache",
  ".tox",
  ".turbo",
  ".venv",
  ".vite",
  ".cache",
  "__pycache__",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
  "target",
  "vendor",
  "venv"
]);
const PRIORITY_ROOT_FILES = [
  "agents.md",
  "claude.md",
  "readme.md",
  "package.json",
  "pyproject.toml",
  "cargo.toml",
  "go.mod",
  "pom.xml",
  "makefile"
];
const PRIORITY_DIRECTORIES = [
  "src",
  "app",
  "apps",
  "packages",
  "lib",
  "cmd",
  "internal",
  "server",
  "frontend",
  "backend",
  "test",
  "tests",
  "docs"
];
class ProjectRegistry {
  constructor(repository) {
    this.repository = repository;
  }
  repository;
  activeProjectId = null;
  get activeScope() {
    return this.activeProjectId;
  }
  async selectPath(path) {
    const canonicalPath = await realpath(path);
    const info = await stat(canonicalPath);
    if (!info.isDirectory()) throw new Error("The selected path is not a directory.");
    let project = await this.repository.getProjectByPath(canonicalPath);
    if (!project) {
      project = await this.repository.createProject({ canonicalPath, displayName: basename(canonicalPath) || canonicalPath });
    }
    await this.repository.touchProject(project.id);
    const context = await this.ensureContext(project);
    this.activeProjectId = project.id;
    return this.toActiveContext(project, context);
  }
  clear() {
    this.activeProjectId = null;
    const cwd = process.cwd();
    return {
      descriptor: { projectId: null, displayName: "Choose folder", canonicalPath: null },
      cwd,
      contextVersion: null,
      projectContext: [{ role: "user", content: formatUnprojectedContext(cwd) }]
    };
  }
  async getActiveContext() {
    if (!this.activeProjectId) return this.clear();
    const project = await this.repository.getProject(this.activeProjectId);
    if (!project) return this.clear();
    const context = await this.ensureContext(project);
    return this.toActiveContext(project, context);
  }
  async markContextDirty(projectId) {
    if (projectId) await this.repository.markProjectContextDirty(projectId);
  }
  toActiveContext(project, context) {
    return {
      descriptor: { projectId: project.id, displayName: project.displayName, canonicalPath: project.canonicalPath },
      cwd: project.canonicalPath,
      contextVersion: context.treeHash,
      projectContext: [{ role: "user", content: formatProjectContext(project, context) }]
    };
  }
  async ensureContext(project) {
    const cached = await this.repository.getProjectContext(project.id);
    if (cached && !cached.dirty && cached.scanPolicyVersion === SCAN_POLICY_VERSION && Date.now() - cached.capturedAt < MAX_CACHE_AGE_MS) return cached;
    const budget = { remainingNodes: MAX_TREE_NODES };
    const scan = await scanTree(project.canonicalPath, 0, budget);
    const snapshot = {
      schemaVersion: 2,
      root: project.canonicalPath,
      maxDepth: MAX_DEPTH,
      maxEntriesPerDirectory: MAX_ENTRIES_PER_DIRECTORY,
      maxTotalEntries: MAX_TREE_NODES,
      entries: scan.entries,
      omittedEntries: scan.omittedEntries,
      treeBudgetReached: scan.treeBudgetReached,
      unreadable: scan.unreadable
    };
    const treeJson = JSON.stringify(snapshot);
    const treeHash = createHash("sha256").update(treeJson).digest("hex");
    return this.repository.saveProjectContext(project.id, {
      treeJson,
      treeHash,
      scanPolicyVersion: SCAN_POLICY_VERSION,
      complete: true,
      dirty: false
    });
  }
}
async function readDirectoryEntries(directory, depth) {
  let handle;
  try {
    handle = await opendir(directory);
  } catch {
    return { entries: [], totalEntries: 0, unreadable: true };
  }
  const entries = [];
  let totalEntries = 0;
  try {
    for await (const entry of handle) {
      const isDirectory = entry.isDirectory();
      if (isNoisyName(entry.name, isDirectory) || !isDirectory && !entry.isFile()) continue;
      totalEntries += 1;
      let insertionIndex = entries.findIndex((current) => compareEntries(entry, current, depth) < 0);
      if (insertionIndex < 0) insertionIndex = entries.length;
      if (insertionIndex >= MAX_ENTRIES_PER_DIRECTORY) continue;
      entries.splice(insertionIndex, 0, entry);
      if (entries.length > MAX_ENTRIES_PER_DIRECTORY) entries.pop();
    }
  } catch {
    return { entries, totalEntries, unreadable: true };
  }
  return { entries, totalEntries, unreadable: false };
}
function isNoisyName(name2, isDirectory) {
  if (name2.startsWith(".")) return true;
  if (!isDirectory) return false;
  const normalized = name2.toLowerCase();
  return IGNORED_DIRECTORY_NAMES.has(normalized) || /^node-compile-cache(?:[-_.].*)?$/i.test(name2) || /^tsx-\d+$/i.test(name2);
}
function compareEntries(left, right, depth) {
  const priorityDelta = entryPriority(left, depth) - entryPriority(right, depth);
  if (priorityDelta !== 0) return priorityDelta;
  const leftName = left.name.toLowerCase();
  const rightName = right.name.toLowerCase();
  return leftName.localeCompare(rightName) || left.name.localeCompare(right.name);
}
function entryPriority(entry, depth) {
  const normalizedName = entry.name.toLowerCase();
  if (depth === 0 && entry.isFile()) {
    const index = PRIORITY_ROOT_FILES.indexOf(normalizedName);
    if (index >= 0) return index;
  }
  if (entry.isDirectory()) {
    const index = PRIORITY_DIRECTORIES.indexOf(normalizedName);
    return 100 + (index >= 0 ? index : PRIORITY_DIRECTORIES.length);
  }
  return 1e3;
}
async function scanTree(directory, depth, budget) {
  const listing = await readDirectoryEntries(directory, depth);
  if (listing.unreadable && listing.entries.length === 0) {
    return { entries: [], omittedEntries: 0, treeBudgetReached: false, unreadable: true };
  }
  const nodesBeforeScan = budget.remainingNodes;
  const selectedCount = Math.min(listing.entries.length, MAX_ENTRIES_PER_DIRECTORY, nodesBeforeScan);
  const selectedEntries = listing.entries.slice(0, selectedCount);
  const omittedEntries = Math.max(0, listing.totalEntries - selectedEntries.length);
  budget.remainingNodes -= selectedEntries.length;
  let treeBudgetReached = listing.totalEntries > selectedEntries.length && nodesBeforeScan < Math.min(listing.totalEntries, MAX_ENTRIES_PER_DIRECTORY);
  let unreadable = listing.unreadable;
  const nodes = [];
  for (const entry of selectedEntries) {
    const isDirectory = entry.isDirectory();
    const node = { name: entry.name, kind: isDirectory ? "directory" : "file" };
    if (isDirectory) {
      if (depth >= MAX_DEPTH) {
        node.childrenOmittedReason = "depth-limit";
      } else if (budget.remainingNodes <= 0) {
        node.childrenOmittedReason = "tree-budget";
        treeBudgetReached = true;
      } else {
        const children = await scanTree(join$1(directory, entry.name), depth + 1, budget);
        node.children = children.entries;
        if (children.omittedEntries > 0) node.omittedEntries = children.omittedEntries;
        if (children.unreadable) node.childrenOmittedReason = "unreadable";
        treeBudgetReached ||= children.treeBudgetReached;
        unreadable ||= children.unreadable;
      }
    }
    nodes.push(node);
  }
  return { entries: nodes, omittedEntries, treeBudgetReached, unreadable };
}
function formatProjectContext(project, context) {
  const snapshot = parseTreeSnapshot(context.treeJson);
  const header = [
    "<project_context>",
    `Project: ${JSON.stringify(project.displayName)}`,
    `Current working directory: ${JSON.stringify(project.canonicalPath)}`,
    "The selected directory is the working directory for this run.",
    snapshot ? `Project map: partial, maximum depth ${snapshot.maxDepth}, ${snapshot.maxEntriesPerDirectory} entries per directory, ${snapshot.maxTotalEntries} total entries.` : "Project map: unavailable; use filesystem tools to inspect the selected directory.",
    "Hidden and common generated/cache directories are omitted from this map.",
    "The map contains paths, not file contents. Use filesystem tools when you need details."
  ];
  const treeLines = [];
  if (snapshot) {
    if (snapshot.unreadable) treeLines.push("- Some directories could not be listed.");
    appendTreeEntries(snapshot.entries, 0, treeLines);
    if (snapshot.omittedEntries > 0) treeLines.push(`- … ${snapshot.omittedEntries} root entries are outside this bounded map.`);
    if (snapshot.treeBudgetReached) treeLines.push("- Additional paths omitted after reaching the total map limit.");
  }
  const closing = "</project_context>";
  const clippingNotice = "- Additional map lines omitted to fit the context budget; use filesystem tools to explore further.";
  const headerText = header.join("\n");
  const baseSize = headerText.length + closing.length + 2;
  const lineBudget = Math.max(0, MAX_PROJECT_CONTEXT_CHARS - baseSize - clippingNotice.length - 2);
  const visibleTreeLines = [];
  let usedChars = 0;
  let clipped = false;
  for (const line of treeLines) {
    const cost = line.length + (visibleTreeLines.length > 0 ? 1 : 0);
    if (usedChars + cost > lineBudget) {
      clipped = true;
      break;
    }
    visibleTreeLines.push(line);
    usedChars += cost;
  }
  return [...header, ...visibleTreeLines, ...clipped ? [clippingNotice] : [], closing].join("\n");
}
function formatUnprojectedContext(cwd) {
  return [
    "<workspace_context>",
    "No project is selected.",
    `Current working directory: ${JSON.stringify(cwd)}`,
    "Filesystem tools are available. Relative paths use this working directory.",
    "No project directory map is attached.",
    "</workspace_context>"
  ].join("\n");
}
function parseTreeSnapshot(treeJson) {
  try {
    const value = JSON.parse(treeJson);
    if (value.schemaVersion !== 2 || typeof value.root !== "string" || !Array.isArray(value.entries)) return null;
    return value;
  } catch {
    return null;
  }
}
function appendTreeEntries(entries, depth, lines) {
  for (const entry of entries) {
    const indent = "  ".repeat(depth);
    lines.push(`${indent}- ${formatEntryName(entry.name)}${entry.kind === "directory" ? "/" : ""}`);
    if (entry.omittedEntries) lines.push(`${indent}  … ${entry.omittedEntries} immediate entries are outside this bounded map.`);
    if (entry.childrenOmittedReason) {
      const reason = {
        "depth-limit": `Subdirectories beyond depth ${MAX_DEPTH} are omitted.`,
        "tree-budget": "Subdirectory contents are omitted at the total map limit.",
        unreadable: "This directory could not be listed."
      }[entry.childrenOmittedReason];
      lines.push(`${indent}  [${reason}]`);
    }
    if (entry.children?.length) appendTreeEntries(entry.children, depth + 1, lines);
  }
}
function formatEntryName(name2) {
  if (!/[\u0000-\u001f\u007f<>]/.test(name2)) return name2;
  return JSON.stringify(name2).replace(/</g, "\\u003c").replace(/>/g, "\\u003e");
}
const CONTEXT_TTL_MS = 10 * 60 * 1e3;
const MAX_CONTEXTS = 32;
const MAX_SELECTION_ELEMENTS = 1e3;
const MAX_INPUT_JSON_LENGTH = 20 * 1024 * 1024;
const MAX_MODEL_JSON_LENGTH = 512 * 1024;
const MAX_VISUAL_DATA_URL_LENGTH = 8 * 1024 * 1024;
class CanvasContextRegistry {
  constructor() {
    this.contexts = /* @__PURE__ */ new Map();
  }
  async prepare(input) {
    if (input.scope !== "selection") throw new Error("The canvas context scope is invalid.");
    if (input.projectId !== null && (typeof input.projectId !== "string" || input.projectId.length === 0)) {
      throw new Error("The canvas project is invalid.");
    }
    const selection = parseSelection(input.serializedJSON);
    const selectedIds = validateSelectedIds(input.selectedElementIds);
    if (selection.elements.length !== selectedIds.size) {
      throw new Error("The canvas selection does not match the selected elements.");
    }
    const imageFileIds = /* @__PURE__ */ new Set();
    let imageCount = 0;
    for (const element of selection.elements) {
      const id = element.id;
      if (typeof id !== "string" || !selectedIds.delete(id) || element.isDeleted === true || element.deleted === true) {
        throw new Error("The canvas selection does not match the selected elements.");
      }
      if (typeof element.type !== "string" || element.type.length === 0) {
        throw new Error("The canvas selection contains an invalid element.");
      }
      if (element.type === "image") {
        imageCount += 1;
        if (typeof element.fileId === "string") imageFileIds.add(element.fileId);
      }
    }
    if (selectedIds.size > 0) throw new Error("The canvas selection does not match the selected elements.");
    if (input.coordinateSpace !== "scene") throw new Error("The canvas coordinate space is invalid.");
    const selectionBounds = validateSelectionBounds(input.selectionBounds);
    const files = stripImageData(selection.files, imageFileIds);
    const visual = validateVisual(input.visual, imageCount);
    const text = JSON.stringify({
      type: selection.type,
      version: selection.version,
      source: selection.source,
      elements: selection.elements,
      appState: selection.appState,
      files,
      canvasContext: { coordinateSpace: "scene", selectionBounds }
    }, null, 2);
    if (text.length > MAX_MODEL_JSON_LENGTH) throw new Error("The canvas selection is too large for one model reference.");
    const descriptor = Object.freeze({
      contextId: randomUUID(),
      projectId: input.projectId,
      label: `Canvas selection · ${selection.elements.length} elements`,
      scope: "selection",
      elementCount: selection.elements.length,
      imageCount,
      hasVisual: Boolean(visual)
    });
    const context = Object.freeze({
      descriptor,
      text,
      ...visual ? { visual } : {}
    });
    this.prune();
    this.contexts.set(descriptor.contextId, { context, expiresAt: Date.now() + CONTEXT_TTL_MS });
    while (this.contexts.size > MAX_CONTEXTS) {
      const oldest = this.contexts.keys().next().value;
      if (!oldest) break;
      this.contexts.delete(oldest);
    }
    return descriptor;
  }
  peekMany(ids, projectId) {
    this.prune();
    return [...new Set(ids)].map((id) => {
      const context = this.contexts.get(id)?.context;
      if (!context) throw new Error("The canvas reference expired. Add it to the message again.");
      if (context.descriptor.projectId !== projectId) {
        throw new Error("The canvas reference belongs to another project. Add it to the message again.");
      }
      return context;
    });
  }
  consumeMany(ids) {
    for (const id of ids) this.contexts.delete(id);
  }
  clearAll() {
    this.contexts.clear();
  }
  prune() {
    const now2 = Date.now();
    for (const [id, record2] of this.contexts) if (record2.expiresAt <= now2) this.contexts.delete(id);
  }
}
function parseSelection(serializedJSON) {
  if (typeof serializedJSON !== "string" || serializedJSON.length > MAX_INPUT_JSON_LENGTH) {
    throw new Error("The canvas selection JSON is invalid or too large.");
  }
  let parsed;
  try {
    parsed = JSON.parse(serializedJSON);
  } catch {
    throw new Error("The canvas selection JSON is invalid.");
  }
  if (!isRecord$1(parsed) || parsed.type !== "excalidraw" || parsed.version !== 2 || typeof parsed.source !== "string" || !Array.isArray(parsed.elements) || parsed.elements.length === 0 || parsed.elements.length > MAX_SELECTION_ELEMENTS || !parsed.elements.every(isRecord$1) || !isRecord$1(parsed.appState) || !isRecord$1(parsed.files)) {
    throw new Error("The canvas selection JSON is invalid.");
  }
  return parsed;
}
function validateSelectedIds(ids) {
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > MAX_SELECTION_ELEMENTS || !ids.every((id) => typeof id === "string" && id.length > 0 && id.length <= 256)) {
    throw new Error("Canvas selection context must include at least one existing element.");
  }
  const unique = new Set(ids);
  if (unique.size !== ids.length) throw new Error("The canvas selection contains duplicate element IDs.");
  return unique;
}
function validateSelectionBounds(value) {
  if (!isRecord$1(value) || ![value.x, value.y, value.width, value.height].every((number) => typeof number === "number" && Number.isFinite(number) && Math.abs(number) <= 1e9) || value.width < 0 || value.height < 0) {
    throw new Error("The canvas selection bounds are invalid.");
  }
  return { x: value.x, y: value.y, width: value.width, height: value.height };
}
function stripImageData(files, imageFileIds) {
  const result = /* @__PURE__ */ Object.create(null);
  for (const id of imageFileIds) {
    if (!Object.hasOwn(files, id)) throw new Error("The canvas selection is missing an image asset.");
  }
  for (const [id, file] of Object.entries(files)) {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id) || !imageFileIds.has(id) || !isRecord$1(file)) {
      throw new Error("The canvas selection contains an unrelated image asset.");
    }
    const { dataURL: _dataURL, ...metadata } = file;
    result[id] = metadata;
  }
  return result;
}
function validateVisual(visual, imageCount) {
  if (!visual) return void 0;
  if (imageCount === 0 || visual.mediaType !== "image/png" || typeof visual.dataURL !== "string" || visual.dataURL.length > MAX_VISUAL_DATA_URL_LENGTH || !/^data:image\/png;base64,[a-z0-9+/]+={0,2}$/i.test(visual.dataURL)) {
    throw new Error("The canvas visual snapshot is invalid or too large.");
  }
  return Object.freeze({ mediaType: "image/png", dataURL: visual.dataURL });
}
function isRecord$1(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
const MAX_ELEMENTS = 2e4;
const MAX_FILES = 1e3;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const UNPROJECTED_SCOPE = "__unprojected__";
class CanvasDocumentStore {
  constructor(userDataPath) {
    this.userDataPath = userDataPath;
    this.pendingSaves = /* @__PURE__ */ new Map();
  }
  async waitForIdle() {
    while (this.pendingSaves.size > 0) {
      await Promise.all(this.pendingSaves.values());
    }
  }
  async load(projectId) {
    const scope = canvasScopeKey(projectId);
    await this.pendingSaves.get(scope);
    const paths = this.paths(scope);
    const stored = await readStoredDocument(paths.documentPath);
    if (!stored) return { document: emptyCanvasDocument(), version: persistenceVersion(null) };
    const files = /* @__PURE__ */ Object.create(null);
    for (const [id, file] of Object.entries(stored.files)) {
      const asset = await readFile(this.assetPath(paths.directory, id, file));
      const { assetName: _assetName, ...metadata } = file;
      files[id] = { ...metadata, dataURL: toDataURL(file.mimeType, asset) };
    }
    return {
      document: {
        elements: stored.elements,
        appState: stored.appState,
        files
      },
      version: persistenceVersion(stored)
    };
  }
  save(projectId, document, expectedVersion) {
    const scope = canvasScopeKey(projectId);
    const snapshot = structuredClone(document);
    const baseline = { ...expectedVersion };
    validateDocument(snapshot);
    validateVersion(baseline);
    const previous = this.pendingSaves.get(scope) ?? Promise.resolve();
    const result = previous.then(() => this.write(this.paths(scope), snapshot, baseline));
    const settled = result.then(() => void 0, () => void 0);
    this.pendingSaves.set(scope, settled);
    void settled.then(() => {
      if (this.pendingSaves.get(scope) === settled) this.pendingSaves.delete(scope);
    });
    return result;
  }
  async write(paths, document, expectedVersion) {
    const previous = await readStoredDocument(paths.documentPath);
    const previousVersion = persistenceVersion(previous);
    const storedFiles = /* @__PURE__ */ Object.create(null);
    const assets = /* @__PURE__ */ new Map();
    for (const [id, file] of Object.entries(document.files)) {
      const metadata = {
        id,
        mimeType: file.mimeType,
        created: file.created,
        ...file.lastRetrieved === void 0 ? {} : { lastRetrieved: file.lastRetrieved },
        ...file.version === void 0 ? {} : { version: file.version }
      };
      if (file.dataURL) {
        const bytes = decodeDataURL(file.dataURL, file.mimeType);
        const digest = createHash("sha256").update(bytes).digest("hex");
        metadata.assetName = `${id}.${digest}.${fileExtension(file.mimeType)}`;
        assets.set(join$1(paths.directory, metadata.assetName), bytes);
      } else {
        const oldFile = previous?.files?.[id];
        if (oldFile?.mimeType === file.mimeType && oldFile.assetName) metadata.assetName = oldFile.assetName;
        assets.set(this.assetPath(paths.directory, id, metadata), null);
      }
      storedFiles[id] = metadata;
    }
    const stored = {
      revision: previousVersion.revision + 1,
      elements: document.elements,
      appState: document.appState,
      files: storedFiles
    };
    const nextVersion = persistenceVersion(stored);
    const sameContent = nextVersion.fingerprint === previousVersion.fingerprint;
    if (!sameContent && !sameVersion(expectedVersion, previousVersion)) return { status: "conflict", version: previousVersion };
    if (!sameContent && !Number.isSafeInteger(stored.revision)) throw new Error("The canvas revision limit has been reached.");
    if (assets.size > 0 || !sameContent) await mkdir(paths.directory, { recursive: true });
    for (const [assetPath, bytes] of assets) {
      try {
        const asset = await stat(assetPath);
        if (!asset.isFile()) throw new Error("The canvas image asset is invalid.");
      } catch (error) {
        if (error.code !== "ENOENT" || bytes === null) throw error;
        await writeAtomic(assetPath, bytes);
      }
    }
    const currentVersion = persistenceVersion(await readStoredDocument(paths.documentPath));
    if (nextVersion.fingerprint === currentVersion.fingerprint) return { status: "saved", version: currentVersion };
    if (!sameVersion(previousVersion, currentVersion)) return { status: "conflict", version: currentVersion };
    await writeAtomic(paths.documentPath, JSON.stringify(stored));
    for (const [id, oldFile] of Object.entries(previous?.files ?? {})) {
      const replacement = storedFiles[id];
      if (replacement?.assetName === oldFile.assetName && replacement?.mimeType === oldFile.mimeType) continue;
      try {
        await rm(this.assetPath(paths.directory, id, oldFile), { force: true });
      } catch {
      }
    }
    return { status: "saved", version: nextVersion };
  }
  paths(scope) {
    const directory = join$1(this.userDataPath, "canvases", scope);
    return { directory, documentPath: join$1(directory, "scene.json") };
  }
  assetPath(directory, id, file) {
    if (file.assetName !== void 0) {
      if (!isAssetName(id, file.assetName)) throw new Error("The canvas image asset path is invalid.");
      return join$1(directory, file.assetName);
    }
    return join$1(directory, `${id}.${fileExtension(file.mimeType)}`);
  }
}
function canvasScopeKey(projectId) {
  if (projectId === null) return UNPROJECTED_SCOPE;
  if (typeof projectId !== "string" || projectId === UNPROJECTED_SCOPE || !/^[a-zA-Z0-9_-]{1,128}$/.test(projectId)) {
    throw new Error("The canvas project identity is invalid.");
  }
  return projectId;
}
function emptyCanvasDocument() {
  return { elements: [], appState: {}, files: {} };
}
async function readStoredDocument(path) {
  let serialized;
  try {
    serialized = await readFile(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  const parsed = JSON.parse(serialized);
  if (!isObject(parsed)) throw new Error("The stored canvas document is invalid.");
  const stored = {
    revision: parsed.revision === void 0 ? 0 : parsed.revision,
    elements: parsed.elements === void 0 ? [] : parsed.elements,
    appState: parsed.appState === void 0 ? {} : parsed.appState,
    files: parsed.files === void 0 ? {} : parsed.files
  };
  if (!Number.isSafeInteger(stored.revision) || stored.revision < 0) {
    throw new Error("The stored canvas revision is invalid.");
  }
  validateDocument(stored);
  for (const [id, file] of Object.entries(stored.files)) {
    if (file.assetName !== void 0 && (typeof file.assetName !== "string" || !isAssetName(id, file.assetName))) {
      throw new Error("The canvas image asset path is invalid.");
    }
  }
  return stored;
}
function persistenceVersion(document) {
  const { elements, appState, files } = document ?? emptyCanvasDocument();
  return {
    revision: document?.revision ?? 0,
    fingerprint: createHash("sha256").update(canonicalJSON({ elements, appState, files })).digest("hex")
  };
}
function canonicalJSON(value) {
  return JSON.stringify(value, (_key, item) => {
    if (!isObject(item)) return item;
    return Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]]));
  });
}
function sameVersion(a, b) {
  return a.revision === b.revision && a.fingerprint === b.fingerprint;
}
function validateVersion(version) {
  if (!Number.isSafeInteger(version.revision) || version.revision < 0 || !/^[a-f0-9]{64}$/.test(version.fingerprint)) {
    throw new Error("The canvas persistence version is invalid.");
  }
}
async function writeAtomic(path, contents) {
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, contents, { flag: "wx" });
    await rename(temporaryPath, path);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}
function validateDocument(document) {
  if (!document || !Array.isArray(document.elements) || document.elements.length > MAX_ELEMENTS) {
    throw new Error("The canvas scene is invalid or too large.");
  }
  if (document.elements.some((element) => !isObject(element))) throw new Error("The canvas scene contains an invalid element.");
  if (!isObject(document.appState) || !isObject(document.files) || Object.keys(document.files).length > MAX_FILES) {
    throw new Error("The canvas state is invalid.");
  }
  for (const [id, file] of Object.entries(document.files)) {
    validateFileId(id);
    if (!isObject(file) || typeof file.mimeType !== "string" || !/^image\/[a-z0-9.+-]{1,64}$/i.test(file.mimeType)) {
      throw new Error("The canvas contains an unsupported image asset.");
    }
    if (file.id !== id || !Number.isFinite(file.created) || file.lastRetrieved !== void 0 && !Number.isFinite(file.lastRetrieved) || file.version !== void 0 && !Number.isFinite(file.version) || file.dataURL !== void 0 && typeof file.dataURL !== "string") {
      throw new Error("The canvas image metadata is invalid.");
    }
    if (file.dataURL) decodeDataURL(file.dataURL, file.mimeType);
  }
}
function validateFileId(id) {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id)) throw new Error("The canvas contains an unsupported image asset.");
}
function isAssetName(id, name2) {
  return name2.startsWith(`${id}.`) && /^[a-zA-Z0-9_-]+\.[a-f0-9]{64}\.[a-zA-Z0-9]+$/.test(name2);
}
function fileExtension(mimeType) {
  return mimeType === "image/jpeg" ? "jpg" : mimeType.split("/")[1]?.replace(/[^a-z0-9]/gi, "") || "bin";
}
function decodeDataURL(dataURL, mimeType) {
  const match = /^data:([^;,]+);base64,([a-z0-9+/=\r\n]+)$/i.exec(dataURL);
  if (!match || match[1].toLowerCase() !== mimeType.toLowerCase()) throw new Error("The canvas image data is invalid.");
  const bytes = Buffer.from(match[2].replace(/\s/g, ""), "base64");
  if (bytes.byteLength > MAX_FILE_BYTES) throw new Error("A canvas image is larger than 4 MB.");
  return bytes;
}
function toDataURL(mimeType, bytes) {
  return `data:${mimeType};base64,${bytes.toString("base64")}`;
}
function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
class CanvasEditBridgeError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = "CanvasEditBridgeError";
  }
  code;
}
class CanvasEditBridge {
  constructor(transport, timeoutMs = 2e4) {
    this.transport = transport;
    this.timeoutMs = timeoutMs;
  }
  transport;
  timeoutMs;
  pending = /* @__PURE__ */ new Map();
  request(ownerWebContentsId, body, signal) {
    if (signal?.aborted) {
      return Promise.reject(new CanvasEditBridgeError("cancelled", "The run stopped before the canvas edit began."));
    }
    const request = {
      ...body,
      requestId: randomUUID(),
      deadlineAt: Date.now() + this.timeoutMs
    };
    return new Promise((resolve2, reject) => {
      let sent = false;
      let settled = false;
      let timer;
      let unsubscribeDestroyed = () => void 0;
      const cancel = {
        requestId: request.requestId,
        runId: request.runId,
        projectId: request.projectId
      };
      const finish = (result) => {
        if (settled) return;
        settled = true;
        this.pending.delete(request.requestId);
        if (timer) clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        unsubscribeDestroyed();
        if (result instanceof Error) {
          if (sent) {
            try {
              this.transport.sendCancel(ownerWebContentsId, cancel);
            } catch {
            }
          }
          reject(result);
        } else {
          resolve2(result);
        }
      };
      const onAbort = () => finish(new CanvasEditBridgeError(
        sent ? "outcome_unknown" : "cancelled",
        sent ? "The canvas edit was cancelled while applying; its outcome could not be confirmed." : "The run stopped before the canvas edit began."
      ));
      this.pending.set(request.requestId, {
        ownerWebContentsId,
        request,
        resolve: (result) => finish(result),
        reject: (error) => finish(error),
        cleanup: () => finish(new CanvasEditBridgeError("outcome_unknown", "The canvas edit response was not received."))
      });
      try {
        unsubscribeDestroyed = this.transport.onOwnerDestroyed(ownerWebContentsId, () => {
          finish(new CanvasEditBridgeError(
            sent ? "outcome_unknown" : "canvas_unavailable",
            "The canvas window closed before the edit completed."
          ));
        });
        if (settled) {
          unsubscribeDestroyed();
          return;
        }
        signal?.addEventListener("abort", onAbort, { once: true });
        if (signal?.aborted) {
          onAbort();
          return;
        }
        timer = setTimeout(() => finish(new CanvasEditBridgeError(
          "outcome_unknown",
          "The canvas edit did not respond before its deadline; its outcome could not be confirmed."
        )), this.timeoutMs);
        if (!this.transport.sendRequest(ownerWebContentsId, request)) {
          finish(new CanvasEditBridgeError("canvas_unavailable", "The canvas window is unavailable."));
          return;
        }
        sent = true;
      } catch (error) {
        finish(new CanvasEditBridgeError(
          sent ? "outcome_unknown" : "canvas_unavailable",
          error instanceof Error ? error.message : String(error)
        ));
      }
    });
  }
  handleResult(senderWebContentsId, result) {
    if (!isRecord(result) || typeof result.requestId !== "string") return false;
    const pending = this.pending.get(result.requestId);
    if (!pending || pending.ownerWebContentsId !== senderWebContentsId) return false;
    if (result.runId !== pending.request.runId || result.projectId !== pending.request.projectId) {
      pending.reject(new CanvasEditBridgeError("outcome_unknown", "The canvas edit response belongs to another run or project."));
      return false;
    }
    if (typeof result.ok !== "boolean" || result.appliedElements !== void 0 && !isRecordArray(result.appliedElements) || result.conflicts !== void 0 && !isRecordArray(result.conflicts) || result.createdIds !== void 0 && (!Array.isArray(result.createdIds) || !result.createdIds.every((id) => typeof id === "string"))) {
      pending.reject(new CanvasEditBridgeError("outcome_unknown", "The canvas edit response is invalid."));
      return false;
    }
    pending.resolve(result);
    return true;
  }
  dispose() {
    for (const request of [...this.pending.values()]) request.cleanup();
  }
}
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function isRecordArray(value) {
  return Array.isArray(value) && value.every(isRecord);
}
class CanvasCliExecutor {
  constructor(apply, options = {}) {
    this.apply = apply;
    this.cliPath = options.cliPath ?? fileURLToPath(new URL("./canvas-cli.js", import.meta.url));
    this.execPath = options.execPath ?? process.execPath;
    this.execArgv = [...options.execArgv ?? []];
    this.timeoutMs = options.timeoutMs ?? 25e3;
  }
  apply;
  cliPath;
  execPath;
  execArgv;
  timeoutMs;
  active = /* @__PURE__ */ new Set();
  disposed = false;
  execute(ownerWebContentsId, body, signal) {
    if (signal?.aborted) return Promise.reject(new CanvasEditBridgeError("cancelled", "The run stopped before the Canvas CLI began."));
    if (this.disposed) return Promise.reject(new CanvasEditBridgeError("canvas_unavailable", "The Canvas CLI executor has closed."));
    const snapshot = structuredClone(body);
    const operationsJSON = JSON.stringify(snapshot.operations);
    const input = JSON.stringify({ operations: snapshot.operations });
    if (Buffer.byteLength(input) > MAX_CLI_BYTES) {
      return Promise.reject(new CanvasEditBridgeError("canvas_unavailable", "The Canvas CLI command exceeds its size limit."));
    }
    return new Promise((resolve2, reject) => {
      const controller = new AbortController();
      const chunks = [];
      let size = 0;
      let settled = false;
      let dispatched = false;
      let child;
      let timer;
      let expectedReply;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        this.active.delete(onDispose);
        if (result instanceof Error) {
          controller.abort();
          if (child && child.exitCode === null && child.signalCode === null) terminateChild(child);
          reject(result);
        } else {
          resolve2(result);
        }
      };
      const failure2 = (message) => new CanvasEditBridgeError(dispatched ? "outcome_unknown" : "canvas_unavailable", message);
      const onAbort = () => finish(new CanvasEditBridgeError(dispatched ? "outcome_unknown" : "cancelled", dispatched ? "The Canvas CLI stopped during application; its outcome could not be confirmed." : "The run stopped before the Canvas CLI command was applied."));
      const onDispose = () => finish(failure2("The Canvas CLI executor closed before confirmation."));
      this.active.add(onDispose);
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) {
        onAbort();
        return;
      }
      try {
        child = fork(this.cliPath, ["apply"], {
          execPath: this.execPath,
          execArgv: this.execArgv,
          stdio: ["pipe", "pipe", "pipe", "ipc"],
          serialization: "json",
          env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }
        });
      } catch (error) {
        finish(failure2(error instanceof Error ? error.message : String(error)));
        return;
      }
      const processChild = child;
      timer = setTimeout(() => finish(failure2("The Canvas CLI exceeded its confirmation deadline.")), this.timeoutMs);
      processChild.stdout.on("data", (data) => {
        size += data.length;
        if (size > MAX_CLI_BYTES) finish(failure2("The Canvas CLI reply exceeds its size limit."));
        else chunks.push(data);
      });
      processChild.stderr.on("data", () => void 0);
      processChild.stdin.on("error", () => finish(failure2("The Canvas CLI input channel closed.")));
      processChild.on("error", (error) => finish(failure2(error.message)));
      processChild.on("message", (message) => {
        if (settled) return;
        if (dispatched || !isCliRequest(message) || JSON.stringify(message.operations) !== operationsJSON) {
          finish(failure2("The Canvas CLI sent a command outside its bound invocation."));
          return;
        }
        dispatched = true;
        void Promise.resolve().then(() => this.apply(ownerWebContentsId, snapshot, controller.signal)).then((result) => {
          if (result.runId !== snapshot.runId || result.projectId !== snapshot.projectId) {
            throw new Error("The Canvas reply belongs to another run or project.");
          }
          return { kind: "canvas:result", result: transportResult(result) };
        }).catch((error) => ({
          kind: "canvas:error",
          code: error instanceof CanvasEditBridgeError ? error.code : "outcome_unknown",
          message: error instanceof Error ? error.message : String(error)
        })).then((reply) => {
          if (settled) return;
          expectedReply = reply;
          try {
            processChild.send(reply, (error) => {
              if (error) finish(failure2("The Canvas CLI result channel closed."));
            });
          } catch {
            finish(failure2("The Canvas CLI result channel closed."));
          }
        });
      });
      processChild.once("close", (code) => {
        if (settled) return;
        let reply;
        try {
          reply = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
        }
        if (!isCliReply(reply) || dispatched && (!expectedReply || JSON.stringify(reply) !== JSON.stringify(expectedReply))) {
          finish(failure2("The Canvas CLI exited without a valid confirmation."));
        } else if (reply.kind === "canvas:error") {
          finish(code === 1 ? Object.assign(new Error(reply.message), { code: reply.code }) : failure2("The Canvas CLI exited with an invalid status."));
        } else if (!dispatched || code !== (reply.result.ok ? 0 : 1)) {
          finish(failure2("The Canvas CLI confirmation does not match the editor result."));
        } else {
          finish(reply.result);
        }
      });
      processChild.stdin.end(input);
    });
  }
  dispose() {
    this.disposed = true;
    for (const cancel of [...this.active]) cancel();
  }
}
function terminateChild(child) {
  const timer = setTimeout(() => child.kill("SIGKILL"), 1e3);
  timer.unref();
  child.once("close", () => clearTimeout(timer));
  child.kill();
}
function transportResult(result) {
  return {
    requestId: result.requestId,
    runId: result.runId,
    projectId: result.projectId,
    ok: result.ok,
    ...result.changed === void 0 ? {} : { changed: result.changed },
    ...result.appliedElements ? { appliedElements: result.appliedElements } : {},
    ...result.createdIds ? { createdIds: result.createdIds } : {},
    ...result.conflicts ? { conflicts: result.conflicts } : {},
    ...result.error ? { error: result.error } : {}
  };
}
const SCHEMA_VERSION = 10;
function hasTable(database, name2) {
  const row = database.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?").get(name2);
  return row?.present === 1;
}
function hasColumn(database, table, column) {
  const rows = database.prepare(`PRAGMA table_info(${table})`).all();
  return rows.some((row) => row.name === column);
}
function migrateMessageTimes(database, preserveLegacyDuration) {
  if (!hasColumn(database, "entries", "duration_ms")) {
    database.exec("ALTER TABLE entries ADD COLUMN duration_ms INTEGER");
  }
  if (preserveLegacyDuration && hasColumn(database, "entries", "completed_at")) database.exec(`
    UPDATE entries AS assistant
    SET duration_ms = MAX(0, assistant.completed_at - (
      SELECT user_entry.created_at
      FROM entries AS user_entry
      WHERE user_entry.project_id IS assistant.project_id
        AND user_entry.run_id = assistant.run_id
        AND user_entry.type = 'user_message'
      ORDER BY user_entry.entry_order ASC
      LIMIT 1
    ))
    WHERE assistant.type = 'assistant_message'
      AND assistant.status = 'completed'
      AND assistant.completed_at IS NOT NULL
      AND assistant.duration_ms IS NULL
      AND EXISTS (
        SELECT 1
        FROM entries AS user_entry
        WHERE user_entry.project_id IS assistant.project_id
          AND user_entry.run_id = assistant.run_id
          AND user_entry.type = 'user_message'
      )
  `);
  if (!hasColumn(database, "entries", "completed_at")) {
    database.exec("ALTER TABLE entries ADD COLUMN completed_at INTEGER");
  }
  if (hasColumn(database, "entries", "updated_at")) {
    database.exec(`
      UPDATE entries SET completed_at = COALESCE(completed_at, updated_at)
      WHERE type = 'assistant_message' AND status = 'completed';
      ALTER TABLE entries DROP COLUMN updated_at;
    `);
  }
  database.exec("UPDATE entries SET completed_at = NULL WHERE type != 'assistant_message' OR status != 'completed'");
}
function createProjectSchema(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      canonical_path TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      last_opened_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS project_context (
      project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
      tree_json TEXT NOT NULL,
      tree_hash TEXT NOT NULL,
      captured_at INTEGER NOT NULL,
      scan_policy_version TEXT NOT NULL,
      complete INTEGER NOT NULL CHECK (complete IN (0, 1)),
      dirty INTEGER NOT NULL DEFAULT 0 CHECK (dirty IN (0, 1))
    );

    CREATE TABLE IF NOT EXISTS entries (
      id TEXT PRIMARY KEY,
      project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
      entry_order INTEGER NOT NULL UNIQUE,
      type TEXT NOT NULL CHECK (type IN ('user_message', 'assistant_message', 'tool_result')),
      status TEXT NOT NULL CHECK (status IN ('streaming', 'completed', 'interrupted', 'failed')),
      run_id TEXT NOT NULL,
      turn_id TEXT,
      tool_call_id TEXT,
      revision INTEGER NOT NULL DEFAULT 0,
      payload_version INTEGER NOT NULL DEFAULT 1,
      payload_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      completed_at INTEGER,
      duration_ms INTEGER
    );

    CREATE INDEX IF NOT EXISTS entries_project_order_idx
      ON entries (project_id, entry_order ASC);
    CREATE INDEX IF NOT EXISTS entries_tool_call_idx
      ON entries (project_id, tool_call_id);

    CREATE TABLE IF NOT EXISTS pending_run_inputs (
      accept_order INTEGER PRIMARY KEY AUTOINCREMENT,
      input_id TEXT NOT NULL UNIQUE,
      project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
      run_id TEXT NOT NULL,
      content TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('accepted', 'applied', 'unapplied')),
      accepted_at INTEGER NOT NULL,
      applied_at INTEGER,
      terminal_reason TEXT,
      CHECK (
        (state = 'accepted' AND applied_at IS NULL AND terminal_reason IS NULL)
        OR (state = 'applied' AND applied_at IS NOT NULL AND terminal_reason IS NULL)
        OR (state = 'unapplied' AND applied_at IS NULL AND terminal_reason IS NOT NULL)
      )
    );

    CREATE INDEX IF NOT EXISTS pending_run_inputs_scope_idx
      ON pending_run_inputs (project_id, run_id, state, accept_order);
    CREATE INDEX IF NOT EXISTS pending_run_inputs_recovery_idx
      ON pending_run_inputs (state, accept_order);

    CREATE TABLE IF NOT EXISTS tool_invocations (
      id TEXT PRIMARY KEY,
      project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
      run_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      cwd TEXT NOT NULL,
      assistant_entry_id TEXT NOT NULL,
      tool_call_id TEXT NOT NULL,
      ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
      tool_name TEXT NOT NULL,
      tool_version TEXT NOT NULL,
      input_json TEXT NOT NULL,
      input_hash TEXT NOT NULL,
      phase TEXT NOT NULL CHECK (phase IN ('planned', 'effect_pending', 'outcome_ready', 'completed')),
      outcome_status TEXT CHECK (outcome_status IS NULL OR outcome_status IN ('succeeded', 'failed', 'cancelled', 'interrupted')),
      outcome_json TEXT,
      recovery_mode_snapshot TEXT NOT NULL CHECK (recovery_mode_snapshot IN ('safe', 'reconcile', 'never')),
      attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
      checkpoint_json TEXT,
      result_entry_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE (run_id, tool_call_id)
    );

    CREATE INDEX IF NOT EXISTS tool_invocations_project_phase_idx
      ON tool_invocations (project_id, phase, ordinal ASC);

    CREATE TABLE IF NOT EXISTS run_cancellations (
      run_id TEXT PRIMARY KEY,
      project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
      cancelled_at INTEGER NOT NULL
    );
  `);
}
function migrateLegacySessionSchema(database) {
  const legacyCompletedAt = hasColumn(database, "entries", "completed_at") ? "completed_at" : "NULL";
  const legacyDurationMs = hasColumn(database, "entries", "duration_ms") ? "duration_ms" : "NULL";
  const legacyCwd = hasColumn(database, "tool_invocations", "cwd") ? "cwd" : "''";
  const legacyToolInvocations = hasTable(database, "tool_invocations");
  database.exec("PRAGMA foreign_keys = OFF");
  database.exec("BEGIN IMMEDIATE");
  try {
    database.exec(`
      CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        canonical_path TEXT NOT NULL UNIQUE,
        display_name TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_opened_at INTEGER NOT NULL
      );

      CREATE TABLE project_context (
        project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
        tree_json TEXT NOT NULL,
        tree_hash TEXT NOT NULL,
        captured_at INTEGER NOT NULL,
        scan_policy_version TEXT NOT NULL,
        complete INTEGER NOT NULL CHECK (complete IN (0, 1)),
        dirty INTEGER NOT NULL DEFAULT 0 CHECK (dirty IN (0, 1))
      );

      CREATE TABLE entries_project_new (
        id TEXT PRIMARY KEY,
        project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
        entry_order INTEGER NOT NULL UNIQUE,
        type TEXT NOT NULL CHECK (type IN ('user_message', 'assistant_message', 'tool_result')),
        status TEXT NOT NULL CHECK (status IN ('streaming', 'completed', 'interrupted', 'failed')),
        run_id TEXT NOT NULL,
        turn_id TEXT,
        tool_call_id TEXT,
        revision INTEGER NOT NULL DEFAULT 0,
        payload_version INTEGER NOT NULL DEFAULT 1,
        payload_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        completed_at INTEGER,
        duration_ms INTEGER
      );

      INSERT INTO entries_project_new
        (id, project_id, entry_order, type, status, run_id, turn_id, tool_call_id,
         revision, payload_version, payload_json, created_at, updated_at, completed_at, duration_ms)
      SELECT id, NULL,
        ROW_NUMBER() OVER (ORDER BY created_at ASC, session_id ASC, session_seq ASC, id ASC),
        type, status, run_id, turn_id, tool_call_id, revision, payload_version,
        payload_json, created_at, updated_at, ${legacyCompletedAt}, ${legacyDurationMs}
      FROM entries;

      DROP TABLE entries;
      ALTER TABLE entries_project_new RENAME TO entries;

      CREATE TABLE tool_invocations_project_new (
        id TEXT PRIMARY KEY,
        project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
        run_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        cwd TEXT NOT NULL,
        assistant_entry_id TEXT NOT NULL,
        tool_call_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
        tool_name TEXT NOT NULL,
        tool_version TEXT NOT NULL,
        input_json TEXT NOT NULL,
        input_hash TEXT NOT NULL,
        phase TEXT NOT NULL CHECK (phase IN ('planned', 'effect_pending', 'outcome_ready', 'completed')),
        outcome_status TEXT CHECK (outcome_status IS NULL OR outcome_status IN ('succeeded', 'failed', 'cancelled', 'interrupted')),
        outcome_json TEXT,
        recovery_mode_snapshot TEXT NOT NULL CHECK (recovery_mode_snapshot IN ('safe', 'reconcile', 'never')),
        attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
        checkpoint_json TEXT,
        result_entry_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE (run_id, tool_call_id)
      );

      ${legacyToolInvocations ? `INSERT INTO tool_invocations_project_new
        (id, project_id, run_id, turn_id, cwd, assistant_entry_id, tool_call_id, ordinal,
         tool_name, tool_version, input_json, input_hash, phase, outcome_status, outcome_json,
         recovery_mode_snapshot, attempt_count, checkpoint_json, result_entry_id, created_at, updated_at)
      SELECT id, NULL, run_id, turn_id, ${legacyCwd}, assistant_entry_id, tool_call_id, ordinal,
        tool_name, tool_version, input_json, input_hash, phase, outcome_status, outcome_json,
        recovery_mode_snapshot, attempt_count, checkpoint_json, result_entry_id, created_at, updated_at
      FROM tool_invocations;

      DROP TABLE tool_invocations;` : ""}
      ALTER TABLE tool_invocations_project_new RENAME TO tool_invocations;
      DROP TABLE sessions;

      CREATE INDEX entries_project_order_idx ON entries (project_id, entry_order ASC);
      CREATE INDEX entries_tool_call_idx ON entries (project_id, tool_call_id);
      CREATE INDEX tool_invocations_project_phase_idx
        ON tool_invocations (project_id, phase, ordinal ASC);

      CREATE TABLE pending_run_inputs (
        accept_order INTEGER PRIMARY KEY AUTOINCREMENT,
        input_id TEXT NOT NULL UNIQUE,
        project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
        run_id TEXT NOT NULL,
        content TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('accepted', 'applied', 'unapplied')),
        accepted_at INTEGER NOT NULL,
        applied_at INTEGER,
        terminal_reason TEXT,
        CHECK (
          (state = 'accepted' AND applied_at IS NULL AND terminal_reason IS NULL)
          OR (state = 'applied' AND applied_at IS NOT NULL AND terminal_reason IS NULL)
          OR (state = 'unapplied' AND applied_at IS NULL AND terminal_reason IS NOT NULL)
        )
      );
      CREATE INDEX pending_run_inputs_scope_idx
        ON pending_run_inputs (project_id, run_id, state, accept_order);
      CREATE INDEX pending_run_inputs_recovery_idx
        ON pending_run_inputs (state, accept_order);
    `);
    createProjectSchema(database);
    migrateMessageTimes(database, true);
    database.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    database.exec("COMMIT");
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } finally {
      database.exec("PRAGMA foreign_keys = ON");
    }
    throw error;
  }
  database.exec("PRAGMA foreign_keys = ON");
}
function initializeSchema(database) {
  database.exec("PRAGMA journal_mode = WAL");
  database.exec("PRAGMA foreign_keys = ON");
  database.exec("PRAGMA synchronous = FULL");
  database.exec("PRAGMA busy_timeout = 5000");
  const current = database.prepare("PRAGMA user_version").get();
  const version = Number(current.user_version);
  if (version > SCHEMA_VERSION) throw new Error(`Unsupported future history storage schema version: ${version}`);
  if (hasTable(database, "sessions")) {
    if (version < SCHEMA_VERSION) migrateLegacySessionSchema(database);
    return;
  }
  createProjectSchema(database);
  if (version < SCHEMA_VERSION) {
    database.exec("BEGIN IMMEDIATE");
    try {
      migrateMessageTimes(database, version < 9);
      database.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }
}
function isJsonObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function sqliteRepositoryError(error, prefix = "") {
  const errcode = error !== null && typeof error === "object" && "errcode" in error ? error.errcode : void 0;
  const primaryCode = typeof errcode === "number" ? errcode & 255 : void 0;
  return new RepositoryError(`${prefix}${error instanceof Error ? error.message : String(error)}`, primaryCode === 19 ? "conflict" : "storage", {
    cause: error,
    // Only lock contention is known to be transient; IO, corruption and full disks are not retried.
    retryable: primaryCode === 5 || primaryCode === 6
  });
}
function now() {
  return Date.now();
}
function serializeJson(value, field) {
  try {
    return canonicalJson(value);
  } catch (cause) {
    throw new RepositoryError(`${field} must be JSON serializable.`, "invalid", { cause });
  }
}
function parseJson(value, field) {
  if (value === null || value === void 0) return null;
  if (typeof value !== "string") throw new RepositoryError(`Stored ${field} is not text.`, "storage");
  try {
    return JSON.parse(value);
  } catch {
    throw new RepositoryError(`Stored ${field} is invalid JSON.`, "storage");
  }
}
function parsePayload(value) {
  if (typeof value !== "string") throw new RepositoryError("Stored entry payload is not text.", "storage");
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new RepositoryError("Stored entry payload is invalid JSON.", "storage");
  }
  const message = readModelMessage(parsed);
  if (!message) throw new RepositoryError("Stored entry payload is not a ModelMessage.", "storage");
  return message;
}
function validatePayloadForType(type, payload, toolCallId) {
  if (!readModelMessage(payload)) throw new RepositoryError("Entry payload must be a valid ModelMessage.", "invalid");
  const expectedRole = type === "user_message" ? "user" : type === "assistant_message" ? "assistant" : "tool";
  if (payload.role !== expectedRole) throw new RepositoryError(`${type} payload must use role ${expectedRole}.`, "invalid");
  if (type === "tool_result" && (!toolCallId || payload.toolCallId !== toolCallId)) throw new RepositoryError("tool_result requires a matching toolCallId.", "invalid");
}
function rowToProject(row) {
  return {
    id: String(row.id),
    canonicalPath: String(row.canonical_path),
    displayName: String(row.display_name),
    createdAt: Number(row.created_at),
    lastOpenedAt: Number(row.last_opened_at)
  };
}
function rowToProjectContext(row) {
  return {
    projectId: String(row.project_id),
    treeJson: String(row.tree_json),
    treeHash: String(row.tree_hash),
    capturedAt: Number(row.captured_at),
    scanPolicyVersion: String(row.scan_policy_version),
    complete: Number(row.complete) === 1,
    dirty: Number(row.dirty) === 1
  };
}
function rowToEntry(row) {
  if (Number(row.payload_version) !== 1) throw new RepositoryError(`Unsupported stored payload version: ${row.payload_version}`, "storage");
  return {
    id: String(row.id),
    projectId: row.project_id === null || row.project_id === void 0 ? null : String(row.project_id),
    entryOrder: Number(row.entry_order),
    type: String(row.type),
    status: String(row.status),
    runId: String(row.run_id),
    turnId: row.turn_id === null || row.turn_id === void 0 ? null : String(row.turn_id),
    toolCallId: row.tool_call_id === null || row.tool_call_id === void 0 ? null : String(row.tool_call_id),
    revision: Number(row.revision),
    payloadVersion: Number(row.payload_version),
    payload: parsePayload(row.payload_json),
    createdAt: Number(row.created_at),
    completedAt: row.completed_at === null || row.completed_at === void 0 ? null : Number(row.completed_at),
    durationMs: row.duration_ms === null || row.duration_ms === void 0 ? null : Number(row.duration_ms)
  };
}
function rowToPendingRunInput(row) {
  return {
    inputId: String(row.input_id),
    projectId: row.project_id === null || row.project_id === void 0 ? null : String(row.project_id),
    runId: String(row.run_id),
    content: String(row.content),
    acceptOrder: Number(row.accept_order),
    state: String(row.state),
    acceptedAt: Number(row.accepted_at),
    appliedAt: row.applied_at === null || row.applied_at === void 0 ? null : Number(row.applied_at),
    terminalReason: row.terminal_reason === null || row.terminal_reason === void 0 ? null : String(row.terminal_reason)
  };
}
function rowToToolInvocation(row) {
  return {
    id: String(row.id),
    projectId: row.project_id === null || row.project_id === void 0 ? null : String(row.project_id),
    runId: String(row.run_id),
    turnId: String(row.turn_id),
    cwd: String(row.cwd),
    assistantEntryId: String(row.assistant_entry_id),
    toolCallId: String(row.tool_call_id),
    ordinal: Number(row.ordinal),
    toolName: String(row.tool_name),
    toolVersion: String(row.tool_version),
    inputJson: String(row.input_json),
    inputHash: String(row.input_hash),
    phase: String(row.phase),
    outcomeStatus: row.outcome_status === null || row.outcome_status === void 0 ? null : String(row.outcome_status),
    outcomeJson: parseJson(row.outcome_json, "tool outcome"),
    recoveryModeSnapshot: String(row.recovery_mode_snapshot),
    attemptCount: Number(row.attempt_count),
    checkpoint: parseJson(row.checkpoint_json, "tool checkpoint"),
    resultEntryId: row.result_entry_id === null || row.result_entry_id === void 0 ? null : String(row.result_entry_id),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at)
  };
}
class SqliteHistoryRepository {
  database;
  constructor(path) {
    this.database = new DatabaseSync(path);
    initializeSchema(this.database);
  }
  async createProject(input) {
    const id = input.id ?? randomUUID();
    const createdAt = input.createdAt ?? now();
    const lastOpenedAt = input.lastOpenedAt ?? createdAt;
    const project = { id, canonicalPath: input.canonicalPath, displayName: input.displayName, createdAt, lastOpenedAt };
    try {
      this.database.prepare(`
        INSERT INTO projects (id, canonical_path, display_name, created_at, last_opened_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(project.id, project.canonicalPath, project.displayName, project.createdAt, project.lastOpenedAt);
    } catch (error) {
      throw new RepositoryError(`Failed to create project: ${error instanceof Error ? error.message : String(error)}`, "conflict");
    }
    return project;
  }
  async getProject(projectId) {
    const row = this.database.prepare("SELECT * FROM projects WHERE id = ?").get(projectId);
    return row ? rowToProject(row) : null;
  }
  async getProjectByPath(canonicalPath) {
    const row = this.database.prepare("SELECT * FROM projects WHERE canonical_path = ?").get(canonicalPath);
    return row ? rowToProject(row) : null;
  }
  async listProjects() {
    const rows = this.database.prepare("SELECT * FROM projects ORDER BY last_opened_at DESC, display_name ASC, id ASC").all();
    return rows.map(rowToProject);
  }
  async touchProject(projectId, lastOpenedAt = now()) {
    const result = this.database.prepare("UPDATE projects SET last_opened_at = ? WHERE id = ?").run(lastOpenedAt, projectId);
    if (Number(result.changes) !== 1) throw new RepositoryError(`Project not found: ${projectId}`, "not_found");
    return await this.getProject(projectId);
  }
  async getProjectContext(projectId) {
    const row = this.database.prepare("SELECT * FROM project_context WHERE project_id = ?").get(projectId);
    return row ? rowToProjectContext(row) : null;
  }
  async saveProjectContext(projectId, input) {
    if (!await this.getProject(projectId)) throw new RepositoryError(`Project not found: ${projectId}`, "not_found");
    const capturedAt = input.capturedAt ?? now();
    this.database.prepare(`
      INSERT INTO project_context
        (project_id, tree_json, tree_hash, captured_at, scan_policy_version, complete, dirty)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(project_id) DO UPDATE SET
        tree_json = excluded.tree_json,
        tree_hash = excluded.tree_hash,
        captured_at = excluded.captured_at,
        scan_policy_version = excluded.scan_policy_version,
        complete = excluded.complete,
        dirty = excluded.dirty
    `).run(projectId, input.treeJson, input.treeHash, capturedAt, input.scanPolicyVersion, input.complete ? 1 : 0, input.dirty ? 1 : 0);
    return await this.getProjectContext(projectId);
  }
  async markProjectContextDirty(projectId) {
    this.database.prepare("UPDATE project_context SET dirty = 1 WHERE project_id = ?").run(projectId);
  }
  async appendEntry(projectId, entry) {
    return this.transaction(() => this.appendEntryInTransaction(projectId, entry));
  }
  appendEntryInTransaction(projectId, entry) {
    validatePayloadForType(entry.type, entry.payload, entry.toolCallId);
    if (projectId !== null && !this.database.prepare("SELECT 1 FROM projects WHERE id = ?").get(projectId)) {
      throw new RepositoryError(`Project not found: ${projectId}`, "not_found");
    }
    const existingRow = this.database.prepare("SELECT * FROM entries WHERE id = ?").get(entry.id);
    if (existingRow) {
      const existing = rowToEntry(existingRow);
      const same = existing.projectId === projectId && existing.type === entry.type && existing.status === entry.status && existing.runId === entry.runId && existing.turnId === (entry.turnId ?? null) && existing.toolCallId === (entry.toolCallId ?? null) && existing.payloadVersion === (entry.payloadVersion ?? 1) && canonicalJson(existing.payload) === canonicalJson(entry.payload);
      if (same) return existing;
      throw new RepositoryError(`Entry already exists with different content: ${entry.id}`, "conflict");
    }
    const completedAt = entry.type === "assistant_message" && entry.status === "completed" ? entry.completedAt ?? now() : null;
    const timestamp = entry.createdAt ?? completedAt ?? now();
    const nextOrder = Number(this.database.prepare("SELECT COALESCE(MAX(entry_order), 0) + 1 AS next_order FROM entries").get().next_order);
    this.database.prepare(`
      INSERT INTO entries
        (id, project_id, entry_order, type, status, run_id, turn_id, tool_call_id,
         revision, payload_version, payload_json, created_at, completed_at, duration_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      entry.id,
      projectId,
      nextOrder,
      entry.type,
      entry.status,
      entry.runId,
      entry.turnId ?? null,
      entry.toolCallId ?? null,
      entry.revision ?? 0,
      entry.payloadVersion ?? 1,
      JSON.stringify(entry.payload),
      timestamp,
      completedAt,
      entry.durationMs ?? null
    );
    return rowToEntry(this.database.prepare("SELECT * FROM entries WHERE id = ?").get(entry.id));
  }
  async updateEntry(entryId, expectedRevision, patch) {
    return this.transaction(() => this.updateEntryInTransaction(entryId, expectedRevision, patch));
  }
  updateEntryInTransaction(entryId, expectedRevision, patch) {
    const existingRow = this.database.prepare("SELECT * FROM entries WHERE id = ?").get(entryId);
    if (!existingRow) throw new RepositoryError(`Entry not found: ${entryId}`, "not_found");
    const existing = rowToEntry(existingRow);
    if (existing.revision !== expectedRevision) throw new RepositoryError(`Entry revision conflict: ${entryId}`, "conflict");
    const nextStatus = patch.status ?? existing.status;
    const completedAt = existing.type === "assistant_message" && nextStatus === "completed" ? existing.completedAt ?? patch.completedAt ?? now() : null;
    const nextPayload = patch.payload ?? existing.payload;
    const nextPayloadVersion = patch.payloadVersion ?? existing.payloadVersion;
    const nextTurnId = patch.turnId === void 0 ? existing.turnId : patch.turnId;
    const nextToolCallId = patch.toolCallId === void 0 ? existing.toolCallId : patch.toolCallId;
    const nextDurationMs = patch.durationMs === void 0 ? existing.durationMs : patch.durationMs;
    validatePayloadForType(existing.type, nextPayload, nextToolCallId);
    this.database.prepare(`
      UPDATE entries
      SET status = ?, turn_id = ?, tool_call_id = ?, revision = revision + 1,
          payload_version = ?, payload_json = ?, completed_at = ?, duration_ms = ?
      WHERE id = ? AND revision = ?
    `).run(nextStatus, nextTurnId, nextToolCallId, nextPayloadVersion, JSON.stringify(nextPayload), completedAt, nextDurationMs, entryId, expectedRevision);
    return rowToEntry(this.database.prepare("SELECT * FROM entries WHERE id = ?").get(entryId));
  }
  async getEntry(entryId) {
    const row = this.database.prepare("SELECT * FROM entries WHERE id = ?").get(entryId);
    return row ? rowToEntry(row) : null;
  }
  async listEntries(projectId, cursor = 0, limit = 100) {
    if (!Number.isInteger(cursor) || cursor < 0) throw new RepositoryError("Entry cursor must be a non-negative integer.", "invalid");
    this.validateHistoryLimit(limit);
    const rows = this.database.prepare(`
      SELECT * FROM entries
      WHERE project_id IS ? AND entry_order > ?
      ORDER BY entry_order ASC
      LIMIT ?
    `).all(projectId, cursor, limit);
    return rows.map(rowToEntry);
  }
  async listLatestEntries(projectId, limit) {
    this.validateHistoryLimit(limit);
    const rows = this.database.prepare(`
      SELECT * FROM entries
      WHERE project_id IS ?
      ORDER BY entry_order DESC
      LIMIT ?
    `).all(projectId, limit);
    return rows.map(rowToEntry);
  }
  async listEntriesBefore(projectId, beforeOrder, limit) {
    if (!Number.isSafeInteger(beforeOrder) || beforeOrder <= 0) throw new RepositoryError("History cursor must be a positive safe integer.", "invalid");
    this.validateHistoryLimit(limit);
    const rows = this.database.prepare(`
      SELECT * FROM entries
      WHERE project_id IS ? AND entry_order < ?
      ORDER BY entry_order DESC
      LIMIT ?
    `).all(projectId, beforeOrder, limit);
    return rows.map(rowToEntry);
  }
  async getToolOutcomesForEntries(projectId, entryIds) {
    const ids = [...new Set(entryIds)];
    if (ids.length === 0) return /* @__PURE__ */ new Map();
    const rows = this.database.prepare(`
      SELECT e.id AS entry_id, t.outcome_json
      FROM entries e
      JOIN tool_invocations t ON t.result_entry_id = e.id
        AND t.project_id IS e.project_id
        AND t.run_id = e.run_id
        AND t.turn_id = e.turn_id
        AND t.tool_call_id = e.tool_call_id
      WHERE e.project_id IS ? AND e.type = 'tool_result'
        AND t.phase IN ('outcome_ready', 'completed')
        AND t.outcome_json IS NOT NULL
        AND e.id IN (${ids.map(() => "?").join(", ")})
    `).all(projectId, ...ids);
    return new Map(rows.map((row) => [String(row.entry_id), parseJson(row.outcome_json, "tool outcome")]));
  }
  async acceptRunInput(projectId, input) {
    if (!input.inputId || !input.runId || typeof input.content !== "string" || !input.content.trim()) {
      throw new RepositoryError("Run input identity and non-empty content are required.", "invalid");
    }
    return this.transaction(() => {
      const existing = this.getPendingRunInputById(input.inputId);
      if (existing) {
        if (existing.projectId !== projectId || existing.runId !== input.runId || existing.content !== input.content) {
          throw new RepositoryError(`Run input already exists with different content or scope: ${input.inputId}`, "conflict");
        }
        return existing;
      }
      if (projectId !== null && !this.database.prepare("SELECT 1 FROM projects WHERE id = ?").get(projectId)) {
        throw new RepositoryError(`Project not found: ${projectId}`, "not_found");
      }
      this.database.prepare(`
        INSERT INTO pending_run_inputs
          (input_id, project_id, run_id, content, state, accepted_at, applied_at, terminal_reason)
        VALUES (?, ?, ?, ?, 'accepted', ?, NULL, NULL)
      `).run(input.inputId, projectId, input.runId, input.content, now());
      return this.getPendingRunInputById(input.inputId);
    });
  }
  async listAcceptedRunInputs(projectId, runId) {
    if (!runId) throw new RepositoryError("runId is required.", "invalid");
    const rows = this.database.prepare(`
      SELECT * FROM pending_run_inputs
      WHERE project_id IS ? AND run_id = ? AND state = 'accepted'
      ORDER BY accept_order ASC
    `).all(projectId, runId);
    return rows.map(rowToPendingRunInput);
  }
  async applyRunInputs(projectId, runId, inputIds) {
    if (!runId || !Array.isArray(inputIds) || inputIds.some((id) => typeof id !== "string" || !id)) {
      throw new RepositoryError("runId and inputIds are required.", "invalid");
    }
    if (new Set(inputIds).size !== inputIds.length) throw new RepositoryError("inputIds must be unique.", "invalid");
    if (inputIds.length === 0) return [];
    return this.transaction(() => {
      const selected = inputIds.map((id) => {
        const item = this.getPendingRunInputById(id);
        if (!item) throw new RepositoryError(`Run input not found: ${id}`, "not_found");
        if (item.projectId !== projectId || item.runId !== runId) {
          throw new RepositoryError(`Run input belongs to another scope or run: ${id}`, "conflict");
        }
        if (item.state === "unapplied") throw new RepositoryError(`Run input was abandoned: ${id}`, "conflict");
        return item;
      });
      if (selected.some((item, index) => index > 0 && item.acceptOrder <= selected[index - 1].acceptOrder)) {
        throw new RepositoryError(`Run inputs must be supplied in acceptance order: ${runId}`, "conflict");
      }
      const accepted = selected.filter((item) => item.state === "accepted");
      if (accepted.length > 0) {
        const nextRows = this.database.prepare(`
          SELECT input_id FROM pending_run_inputs
          WHERE project_id IS ? AND run_id = ? AND state = 'accepted'
          ORDER BY accept_order ASC LIMIT ?
        `).all(projectId, runId, accepted.length);
        if (nextRows.length !== accepted.length || nextRows.some((row, index) => row.input_id !== accepted[index].inputId)) {
          throw new RepositoryError(`Run inputs must be applied in acceptance order: ${runId}`, "conflict");
        }
      }
      const timestamp = now();
      let nextOrder = this.nextEntryOrder();
      return selected.map((item) => {
        if (item.state === "applied") return this.getSettledRunInputEntry(item);
        const entry = this.settleRunInput(item, "applied", timestamp, null, nextOrder);
        nextOrder += 1;
        return entry;
      });
    });
  }
  async abandonRunInputs(projectId, runId, reason) {
    if (!runId || !reason.trim()) throw new RepositoryError("runId and terminal reason are required.", "invalid");
    return this.transaction(() => {
      const rows = this.database.prepare(`
        SELECT * FROM pending_run_inputs
        WHERE project_id IS ? AND run_id = ? AND state = 'accepted'
        ORDER BY accept_order ASC
      `).all(projectId, runId);
      return this.settleRunInputBatch(rows.map(rowToPendingRunInput), "unapplied", reason);
    });
  }
  async recoverAcceptedRunInputs(reason) {
    if (!reason.trim()) throw new RepositoryError("Terminal reason is required.", "invalid");
    return this.transaction(() => {
      const rows = this.database.prepare(`
        SELECT * FROM pending_run_inputs WHERE state = 'accepted' ORDER BY accept_order ASC
      `).all();
      return this.settleRunInputBatch(rows.map(rowToPendingRunInput), "unapplied", reason);
    });
  }
  async finalizeAnswerDuration(projectId, turnId, durationMs) {
    if (!turnId || !Number.isSafeInteger(durationMs) || durationMs < 0) {
      throw new RepositoryError("turnId and a non-negative integer durationMs are required.", "invalid");
    }
    this.transaction(() => {
      const rows = this.database.prepare(`
        SELECT * FROM entries
        WHERE project_id IS ? AND turn_id = ? AND type = 'assistant_message' AND status = 'completed'
      `).all(projectId, turnId);
      if (rows.length === 0) throw new RepositoryError(`Completed assistant entry not found for turn: ${turnId}`, "not_found");
      if (rows.length !== 1) throw new RepositoryError(`Multiple completed assistant entries for turn: ${turnId}`, "conflict");
      const entry = rowToEntry(rows[0]);
      if (entry.payload.toolCalls?.length) throw new RepositoryError(`Turn is a tool-call response, not a final answer: ${turnId}`, "conflict");
      if (entry.durationMs !== null) {
        if (entry.durationMs !== durationMs) throw new RepositoryError(`Answer duration already finalized for turn: ${turnId}`, "conflict");
        return;
      }
      this.database.prepare("UPDATE entries SET duration_ms = ?, revision = revision + 1 WHERE id = ? AND duration_ms IS NULL").run(durationMs, entry.id);
    });
  }
  async registerToolInvocation(input) {
    return (await this.registerToolBatch([input]))[0];
  }
  async registerToolBatch(inputs) {
    if (inputs.length === 0) throw new RepositoryError("A tool batch cannot be empty.", "invalid");
    this.validateToolBatchInputs(inputs);
    const first = inputs[0];
    return this.transaction(() => {
      if (first.projectId !== null && !this.database.prepare("SELECT 1 FROM projects WHERE id = ?").get(first.projectId)) {
        throw new RepositoryError(`Project not found: ${first.projectId}`, "not_found");
      }
      return inputs.map((input) => this.registerToolInvocationInTransaction(input));
    });
  }
  async commitAssistantAttempt(projectId, assistant, plans) {
    const entry = assistant.entry;
    validatePayloadForType(entry.type, entry.payload, entry.toolCallId);
    if (entry.type !== "assistant_message" || entry.status === "streaming" || !entry.turnId) {
      throw new RepositoryError("Assistant completion requires a terminal assistant entry and turn identity.", "invalid");
    }
    const inputs = plans.map((plan) => ({ ...plan, projectId, assistantEntryId: entry.id }));
    this.validateToolBatchInputs(inputs);
    const calls = entry.status === "completed" ? entry.payload.toolCalls ?? [] : [];
    if (calls.length !== plans.length || plans.some((plan, index) => {
      const call = calls[index];
      return plan.runId !== entry.runId || plan.turnId !== entry.turnId || plan.ordinal !== index || call.id !== plan.toolCallId || call.name !== plan.toolName || !call.inputComplete || !jsonEqual(call.input, JSON.parse(plan.inputJson));
    })) throw new RepositoryError("The assistant response must match its entire tool plan.", "invalid");
    return this.transaction(() => {
      const row = this.database.prepare("SELECT * FROM entries WHERE id = ?").get(entry.id);
      const previous = row ? rowToEntry(row) : void 0;
      if (previous && (previous.projectId !== projectId || previous.type !== entry.type || previous.runId !== entry.runId || previous.turnId !== entry.turnId)) {
        throw new RepositoryError("The assistant entry belongs to a different scope or attempt.", "conflict");
      }
      let committed;
      if (previous && previous.status !== "streaming") {
        if (previous.status !== entry.status || !jsonEqual(previous.payload, entry.payload)) {
          throw new RepositoryError(`Assistant entry already exists with different content: ${entry.id}`, "conflict");
        }
        committed = previous;
      } else if (assistant.expectedRevision === null) {
        committed = this.appendEntryInTransaction(projectId, entry);
      } else {
        if (!previous) throw new RepositoryError(`Assistant draft not found: ${entry.id}`, "not_found");
        committed = this.updateEntryInTransaction(entry.id, assistant.expectedRevision, {
          status: entry.status,
          payload: entry.payload,
          completedAt: entry.completedAt
        });
      }
      const invocations = inputs.map((input) => this.registerToolInvocationInTransaction(input));
      return { assistant: committed, invocations };
    });
  }
  validateToolBatchInputs(inputs) {
    const first = inputs[0];
    if (!first) return;
    const callIds = /* @__PURE__ */ new Set();
    for (const [index, input] of inputs.entries()) {
      this.validateToolInvocationInput(input);
      if (input.projectId !== first.projectId || input.runId !== first.runId || input.turnId !== first.turnId || input.assistantEntryId !== first.assistantEntryId || callIds.has(input.toolCallId) || inputs.length > 1 && input.ordinal !== index) {
        throw new RepositoryError("Tool batch scope, call identities and ordinal order must be consistent.", "invalid");
      }
      callIds.add(input.toolCallId);
    }
  }
  registerToolInvocationInTransaction(input) {
    const id = input.id ?? randomUUID();
    const resultEntryId = input.resultEntryId ?? randomUUID();
    const timestamp = input.createdAt ?? now();
    const updatedAt = input.updatedAt ?? timestamp;
    const checkpointJson = input.checkpoint === void 0 ? null : serializeJson(input.checkpoint, "checkpoint");
    const previous = this.database.prepare("SELECT * FROM tool_invocations WHERE run_id = ? AND tool_call_id = ?").get(input.runId, input.toolCallId);
    if (previous) {
      const existing = rowToToolInvocation(previous);
      if (existing.projectId !== input.projectId || existing.turnId !== input.turnId || existing.assistantEntryId !== input.assistantEntryId || existing.cwd !== input.cwd || existing.toolName !== input.toolName || existing.toolVersion !== input.toolVersion || existing.ordinal !== input.ordinal || existing.inputHash !== input.inputHash || canonicalJson(JSON.parse(existing.inputJson)) !== canonicalJson(JSON.parse(input.inputJson)) || existing.recoveryModeSnapshot !== input.recoveryModeSnapshot || input.resultEntryId !== void 0 && input.resultEntryId !== existing.resultEntryId) {
        throw new RepositoryError(`Tool call identity conflict: ${input.toolCallId}`, "conflict");
      }
      return existing;
    }
    try {
      this.database.prepare(`
        INSERT INTO tool_invocations
          (id, project_id, run_id, turn_id, cwd, assistant_entry_id, tool_call_id, ordinal,
           tool_name, tool_version, input_json, input_hash, phase, outcome_status,
           outcome_json, recovery_mode_snapshot, attempt_count, checkpoint_json,
           result_entry_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'planned', NULL, NULL, ?, 0, ?, ?, ?, ?)
      `).run(
        id,
        input.projectId,
        input.runId,
        input.turnId,
        input.cwd,
        input.assistantEntryId,
        input.toolCallId,
        input.ordinal,
        input.toolName,
        input.toolVersion,
        input.inputJson,
        input.inputHash,
        input.recoveryModeSnapshot,
        checkpointJson,
        resultEntryId,
        timestamp,
        updatedAt
      );
    } catch (error) {
      throw sqliteRepositoryError(error, "Failed to register tool invocation: ");
    }
    return this.getToolInvocationById(id);
  }
  async requestRunCancellation(projectId, runId) {
    if (!runId) throw new RepositoryError("runId is required for cancellation.", "invalid");
    this.transaction(() => {
      const existing = this.database.prepare("SELECT project_id FROM run_cancellations WHERE run_id = ?").get(runId);
      if (existing && existing.project_id !== projectId) throw new RepositoryError(`Run cancellation scope conflict: ${runId}`, "conflict");
      this.database.prepare("INSERT INTO run_cancellations (run_id, project_id, cancelled_at) VALUES (?, ?, ?) ON CONFLICT(run_id) DO NOTHING").run(runId, projectId, now());
    });
  }
  async isRunCancelled(projectId, runId) {
    return Boolean(this.database.prepare("SELECT 1 FROM run_cancellations WHERE run_id = ? AND project_id IS ?").get(runId, projectId));
  }
  async isToolInvocationBlocked(invocationId) {
    const invocation = this.getToolInvocationById(invocationId);
    if (!invocation) throw new RepositoryError(`Tool invocation not found: ${invocationId}`, "not_found");
    return this.hasPriorInterruptedInvocation(invocation);
  }
  async getToolInvocationCall(invocationId) {
    return this.transaction(() => {
      const invocation = this.getToolInvocationById(invocationId);
      if (!invocation) throw new RepositoryError(`Stored tool invocation not found: ${invocationId}`, "storage");
      const input = parseJson(invocation.inputJson, "tool input");
      if (!isJsonObject(input)) throw new RepositoryError(`Stored tool input must be an object: ${invocationId}`, "storage");
      const hash = toolInputHash(invocation.toolName, invocation.toolVersion, input);
      const legacyHash = toolInputHashFromJson(invocation.toolName, invocation.toolVersion, invocation.inputJson);
      if (invocation.inputHash !== hash && invocation.inputHash !== legacyHash) {
        throw new RepositoryError(`Stored tool input hash does not match: ${invocationId}`, "storage");
      }
      const row = this.database.prepare("SELECT * FROM entries WHERE id = ?").get(invocation.assistantEntryId);
      if (!row) throw new RepositoryError(`Stored tool invocation has no source Assistant: ${invocationId}`, "storage");
      const assistant = rowToEntry(row);
      const call = assistant.payload.toolCalls?.[invocation.ordinal];
      if (assistant.type !== "assistant_message" || assistant.status !== "completed" || assistant.payload.role !== "assistant" || assistant.projectId !== invocation.projectId || assistant.runId !== invocation.runId || assistant.turnId !== invocation.turnId || !call || call.id !== invocation.toolCallId || call.name !== invocation.toolName || !call.inputComplete || !jsonEqual(call.input, input)) {
        throw new RepositoryError(`Stored tool invocation differs from its source Assistant: ${invocationId}`, "storage");
      }
      return call;
    });
  }
  hasPriorInterruptedInvocation(invocation) {
    return Boolean(this.database.prepare(`
      SELECT 1 FROM tool_invocations
      WHERE project_id IS ? AND run_id = ? AND assistant_entry_id = ? AND ordinal < ? AND outcome_status = 'interrupted'
      LIMIT 1
    `).get(invocation.projectId, invocation.runId, invocation.assistantEntryId, invocation.ordinal));
  }
  async beginToolAttempt(invocationId, checkpoint) {
    if (checkpoint !== void 0 && !readToolCheckpoint(checkpoint)) throw new RepositoryError("Tool checkpoint must contain a version, kind and data object.", "invalid");
    const checkpointJson = checkpoint === void 0 ? null : serializeJson(checkpoint, "checkpoint");
    return this.transaction(() => {
      const existing = this.getToolInvocationById(invocationId);
      if (!existing) throw new RepositoryError(`Tool invocation not found: ${invocationId}`, "not_found");
      if (this.database.prepare("SELECT 1 FROM run_cancellations WHERE run_id = ? AND project_id IS ?").get(existing.runId, existing.projectId)) {
        throw new ToolAttemptBlockedError("cancelled", `Cancelled run cannot start a tool attempt: ${existing.runId}`);
      }
      if (existing.phase !== "planned" && existing.phase !== "effect_pending") throw new RepositoryError(`Tool invocation cannot begin from phase ${existing.phase}: ${invocationId}`, "conflict");
      if (existing.phase === "planned" && this.hasPriorInterruptedInvocation(existing)) {
        throw new ToolAttemptBlockedError("prior_interrupted", `A prior tool invocation was interrupted: ${invocationId}`);
      }
      this.database.prepare("UPDATE tool_invocations SET phase = 'effect_pending', attempt_count = attempt_count + 1, checkpoint_json = ?, updated_at = ? WHERE id = ? AND phase = ?").run(checkpointJson, now(), invocationId, existing.phase);
      return this.getToolInvocationById(invocationId);
    });
  }
  async saveToolOutcome(invocationId, outcome) {
    return this.persistToolOutcome(invocationId, outcome, "effect_pending");
  }
  async settleUnstartedToolInvocation(invocationId, outcome) {
    if (outcome.status === "succeeded") {
      throw new RepositoryError("An unstarted invocation can only be failed, cancelled or interrupted.", "invalid");
    }
    return this.persistToolOutcome(invocationId, outcome, "planned");
  }
  persistToolOutcome(invocationId, outcome, expectedPhase) {
    const result = readToolResult(outcome.outcome);
    if (!result || toolOutcomeStatus(result) !== outcome.status) throw new RepositoryError("Tool outcome must contain a valid result with matching status.", "invalid");
    if (outcome.checkpoint !== void 0 && !readToolCheckpoint(outcome.checkpoint)) throw new RepositoryError("Tool checkpoint must contain a version, kind and data object.", "invalid");
    const outcomeJson = serializeJson(outcome.outcome, "tool outcome");
    const checkpointJson = outcome.checkpoint === void 0 ? null : serializeJson(outcome.checkpoint, "checkpoint");
    return this.transaction(() => {
      const existing = this.getToolInvocationById(invocationId);
      if (!existing) throw new RepositoryError(`Tool invocation not found: ${invocationId}`, "not_found");
      if (existing.phase === "outcome_ready" || existing.phase === "completed") {
        if (existing.outcomeStatus !== outcome.status || canonicalJson(existing.outcomeJson) !== canonicalJson(outcome.outcome)) throw new RepositoryError(`Tool outcome already exists with different content: ${invocationId}`, "conflict");
        return existing;
      }
      if (existing.phase !== expectedPhase) throw new RepositoryError(`Tool invocation cannot save outcome from phase ${existing.phase}: ${invocationId}`, "conflict");
      this.database.prepare(`
        UPDATE tool_invocations
        SET phase = 'outcome_ready', outcome_status = ?, outcome_json = ?,
            checkpoint_json = COALESCE(?, checkpoint_json), updated_at = ?
        WHERE id = ? AND phase = ?
      `).run(outcome.status, outcomeJson, checkpointJson, outcome.updatedAt ?? now(), invocationId, expectedPhase);
      return this.getToolInvocationById(invocationId);
    });
  }
  async commitToolResult(projectId, entry, invocationId) {
    validatePayloadForType(entry.type, entry.payload, entry.toolCallId);
    if (entry.type !== "tool_result" || entry.status !== "completed") throw new RepositoryError("Tool result materialization requires a completed tool message.", "invalid");
    return this.transaction(() => {
      if (!invocationId) return this.appendEntryInTransaction(projectId, entry);
      const existing = this.getToolInvocationById(invocationId);
      if (!existing) throw new RepositoryError(`Tool invocation not found: ${invocationId}`, "not_found");
      if (existing.projectId !== projectId || existing.runId !== entry.runId || existing.turnId !== entry.turnId || existing.toolCallId !== entry.toolCallId || existing.resultEntryId !== null && existing.resultEntryId !== entry.id) {
        throw new RepositoryError(`Tool result identity conflict: ${invocationId}`, "conflict");
      }
      if (existing.phase !== "outcome_ready" && existing.phase !== "completed") throw new RepositoryError(`Tool invocation cannot materialize from phase ${existing.phase}: ${invocationId}`, "conflict");
      if (existing.phase === "completed" && !this.database.prepare("SELECT 1 FROM entries WHERE id = ?").get(entry.id)) {
        throw new RepositoryError(`Completed invocation has no persisted result message: ${invocationId}`, "storage");
      }
      const result = readToolResult(existing.outcomeJson);
      if (!result || toolOutcomeStatus(result) !== existing.outcomeStatus) throw new RepositoryError(`Stored tool outcome is invalid: ${invocationId}`, "storage");
      const expectedMessage = toolResultMessage({ id: existing.toolCallId, name: existing.toolName }, result);
      if (!jsonEqual(expectedMessage, entry.payload)) throw new RepositoryError(`Tool message differs from its persisted outcome: ${invocationId}`, "conflict");
      const committed = this.appendEntryInTransaction(projectId, entry);
      if (existing.phase !== "completed") {
        this.database.prepare("UPDATE tool_invocations SET phase = 'completed', result_entry_id = ?, updated_at = ? WHERE id = ? AND phase = 'outcome_ready'").run(committed.id, now(), invocationId);
      }
      return committed;
    });
  }
  async getToolInvocation(projectId, runId, toolCallId) {
    const row = this.database.prepare("SELECT * FROM tool_invocations WHERE project_id IS ? AND run_id = ? AND tool_call_id = ?").get(projectId, runId, toolCallId);
    return row ? rowToToolInvocation(row) : null;
  }
  async listOpenToolInvocations(projectId, runId) {
    const rows = runId ? this.database.prepare("SELECT t.* FROM tool_invocations t LEFT JOIN entries e ON e.id = t.assistant_entry_id WHERE t.project_id IS ? AND t.run_id = ? AND t.phase != 'completed' ORDER BY COALESCE(e.entry_order, t.created_at), t.ordinal ASC, t.id ASC").all(projectId, runId) : this.database.prepare("SELECT t.* FROM tool_invocations t LEFT JOIN entries e ON e.id = t.assistant_entry_id WHERE t.project_id IS ? AND t.phase != 'completed' ORDER BY COALESCE(e.entry_order, t.created_at), t.ordinal ASC, t.id ASC").all(projectId);
    return rows.map(rowToToolInvocation);
  }
  close() {
    this.database.close();
  }
  transaction(operation) {
    let began = false;
    try {
      this.database.exec("BEGIN IMMEDIATE");
      began = true;
      const result = operation();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      let safeToRetry = !began;
      if (began) {
        try {
          this.database.exec("ROLLBACK");
          safeToRetry = true;
        } catch {
        }
      }
      const failure2 = error instanceof RepositoryError ? error : sqliteRepositoryError(error);
      if (failure2.retryable && !safeToRetry) throw new RepositoryError(failure2.message, failure2.code, { cause: failure2 });
      throw failure2;
    }
  }
  validateHistoryLimit(limit) {
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new RepositoryError("History limit must be a positive safe integer.", "invalid");
  }
  getPendingRunInputById(inputId) {
    const row = this.database.prepare("SELECT * FROM pending_run_inputs WHERE input_id = ?").get(inputId);
    return row ? rowToPendingRunInput(row) : null;
  }
  getSettledRunInputEntry(item) {
    const row = this.database.prepare("SELECT * FROM entries WHERE id = ?").get(item.inputId);
    if (!row) throw new RepositoryError(`Settled run input has no history entry: ${item.inputId}`, "storage");
    const entry = rowToEntry(row);
    if (entry.projectId !== item.projectId || entry.runId !== item.runId || entry.type !== "user_message") {
      throw new RepositoryError(`Settled run input entry has a different scope: ${item.inputId}`, "storage");
    }
    return entry;
  }
  nextEntryOrder() {
    return Number(this.database.prepare("SELECT COALESCE(MAX(entry_order), 0) + 1 AS next_order FROM entries").get().next_order);
  }
  settleRunInputBatch(items, state, reason) {
    const timestamp = now();
    let nextOrder = this.nextEntryOrder();
    return items.map((item) => {
      const entry = this.settleRunInput(item, state, timestamp, reason, nextOrder);
      nextOrder += 1;
      return entry;
    });
  }
  settleRunInput(item, state, timestamp, reason, entryOrder) {
    const existing = this.database.prepare("SELECT 1 FROM entries WHERE id = ?").get(item.inputId);
    if (existing) throw new RepositoryError(`Run input entry ID already exists: ${item.inputId}`, "conflict");
    this.database.prepare(`
      INSERT INTO entries
        (id, project_id, entry_order, type, status, run_id, turn_id, tool_call_id,
         revision, payload_version, payload_json, created_at, completed_at, duration_ms)
      VALUES (?, ?, ?, 'user_message', ?, ?, NULL, NULL, 0, 1, ?, ?, NULL, NULL)
    `).run(
      item.inputId,
      item.projectId,
      entryOrder,
      state === "applied" ? "completed" : "interrupted",
      item.runId,
      JSON.stringify({ role: "user", content: item.content }),
      item.acceptedAt
    );
    const changed = this.database.prepare(`
      UPDATE pending_run_inputs
      SET state = ?, applied_at = ?, terminal_reason = ?
      WHERE input_id = ? AND state = 'accepted'
    `).run(state, state === "applied" ? timestamp : null, reason, item.inputId);
    if (Number(changed.changes) !== 1) throw new RepositoryError(`Run input state changed during settlement: ${item.inputId}`, "conflict");
    return rowToEntry(this.database.prepare("SELECT * FROM entries WHERE id = ?").get(item.inputId));
  }
  validateToolInvocationInput(input) {
    if (!input.runId || !input.turnId || !input.cwd || !input.assistantEntryId || !input.toolCallId || !input.toolName || !input.toolVersion || !input.inputHash) {
      throw new RepositoryError("Tool invocation identity and tool metadata are required.", "invalid");
    }
    if (!Number.isSafeInteger(input.ordinal) || input.ordinal < 0) throw new RepositoryError("Tool invocation ordinal must be a non-negative safe integer.", "invalid");
    try {
      JSON.parse(input.inputJson);
    } catch {
      throw new RepositoryError("Tool invocation inputJson must be valid JSON.", "invalid");
    }
  }
  getToolInvocationById(invocationId) {
    const row = this.database.prepare("SELECT * FROM tool_invocations WHERE id = ?").get(invocationId);
    return row ? rowToToolInvocation(row) : null;
  }
}
const DRAFT_FLUSH_INTERVAL_MS = 500;
const DRAFT_FLUSH_BYTES = 4096;
function cloneMessage(message) {
  let normalized;
  try {
    normalized = JSON.parse(JSON.stringify(message));
  } catch (cause) {
    throw new RepositoryError("History message must be JSON serializable.", "storage", { cause });
  }
  const copy = readModelMessage(normalized);
  if (!copy) throw new RepositoryError("History message must be a valid ModelMessage.", "storage");
  return copy;
}
function freezeSnapshot(messages) {
  return messages.map((message) => Object.freeze(cloneMessage(message)));
}
function validateMessage(message, role) {
  if (message.role !== role) throw new RepositoryError(`Expected a ${role} message.`, "invalid");
}
function draftKey(context) {
  return JSON.stringify([context.turnId, context.attempt ?? 1]);
}
function toolEntryKey(runId, toolCallId) {
  return JSON.stringify([runId, toolCallId]);
}
class DefaultHistoryRecorder {
  projectId;
  repository;
  completedMessages = [];
  completedEntryIds = /* @__PURE__ */ new Set();
  activeDrafts = /* @__PURE__ */ new Map();
  initialUserEntries = /* @__PURE__ */ new Map();
  toolEntries = /* @__PURE__ */ new Map();
  assistantEntries = /* @__PURE__ */ new Map();
  assistantAttempts = /* @__PURE__ */ new Map();
  writeChain = Promise.resolve();
  draftErrors = /* @__PURE__ */ new Map();
  closed = false;
  constructor(projectId, repository, entries = []) {
    this.projectId = projectId;
    this.repository = repository;
    for (const entry of [...entries].sort((left, right) => left.entryOrder - right.entryOrder)) {
      if (entry.projectId !== projectId) throw new RepositoryError("History entry belongs to a different scope.", "conflict");
      if (entry.type === "user_message") {
        if (!this.initialUserEntries.has(entry.runId)) {
          this.initialUserEntries.set(entry.runId, { entryId: entry.id, message: cloneMessage(entry.payload) });
        }
      }
      if (entry.type === "tool_result" && entry.toolCallId && entry.status === "completed") {
        this.toolEntries.set(toolEntryKey(entry.runId, entry.toolCallId), { ...entry, payload: cloneMessage(entry.payload) });
      }
      if (entry.type === "assistant_message" && entry.turnId) this.assistantEntries.set(entry.turnId, entry.id);
      this.appendCompletedEntry(entry);
    }
  }
  snapshot() {
    return freezeSnapshot(this.completedMessages);
  }
  getAssistantEntryId(turnId) {
    return Promise.resolve(this.assistantEntries.get(turnId) ?? null);
  }
  commitUser(message, context) {
    return this.persistInitialUser(message, context, "completed");
  }
  archiveUnappliedUser(message, context) {
    return this.persistInitialUser(message, context, "interrupted");
  }
  persistInitialUser(message, context, status) {
    validateMessage(message, "user");
    this.ensureOpen();
    const copy = cloneMessage(message);
    return this.enqueueResult(async () => {
      const previous = this.initialUserEntries.get(context.runId);
      if (previous) {
        if (context.entryId && previous.entryId !== context.entryId) {
          throw new RepositoryError(`The initial user entry ID changed for run ${context.runId}.`, "conflict");
        }
        if (!jsonEqual(previous.message, copy)) {
          throw new RepositoryError(`A different initial user message already belongs to run ${context.runId}.`, "conflict");
        }
        return;
      }
      const entryId = context.entryId ?? randomUUID();
      const entry = await this.repository.appendEntry(this.projectId, {
        id: entryId,
        type: "user_message",
        status,
        runId: context.runId,
        payload: copy,
        createdAt: context.createdAt
      });
      this.initialUserEntries.set(context.runId, { entryId, message: copy });
      this.appendCompletedEntry(entry);
    });
  }
  acceptRunInput(input) {
    this.ensureOpen();
    return this.enqueueResult(() => this.repository.acceptRunInput(this.projectId, input));
  }
  listAcceptedRunInputs(runId) {
    this.ensureOpen();
    return this.waitForWrites().then(() => this.repository.listAcceptedRunInputs(this.projectId, runId));
  }
  applyRunInputs(runId, inputIds) {
    this.ensureOpen();
    return this.enqueueResult(async () => {
      const entries = await this.repository.applyRunInputs(this.projectId, runId, inputIds);
      for (const entry of entries) this.appendCompletedEntry(entry);
      return entries;
    });
  }
  abandonRunInputs(runId, reason) {
    this.ensureOpen();
    return this.enqueueResult(() => this.repository.abandonRunInputs(this.projectId, runId, reason));
  }
  finalizeAnswerDuration(turnId, durationMs) {
    this.ensureOpen();
    return this.enqueueResult(() => this.repository.finalizeAnswerDuration(this.projectId, turnId, durationMs));
  }
  recordAssistantDelta(kind, delta, context) {
    this.ensureOpen();
    if (!delta) return;
    if (this.assistantAttempts.has(draftKey(context))) throw new RepositoryError("Assistant attempt is already terminal.", "conflict");
    const draft = this.prepareDraft(context);
    if (draft.terminal) throw new RepositoryError("Assistant attempt is already terminal.", "conflict");
    if (kind === "text") draft.message.content += delta;
    else draft.message.reasoning = (draft.message.reasoning ?? "") + delta;
    draft.pendingBytes += Buffer$1.byteLength(delta, "utf8");
    draft.dirty = true;
    if (draft.pendingBytes >= DRAFT_FLUSH_BYTES) {
      this.scheduleFlush(draft, true);
    } else if (draft.timer === void 0) {
      draft.timer = setTimeout(() => {
        draft.timer = void 0;
        void this.enqueueResult(() => this.flushDraft(draft)).catch(() => void 0);
      }, DRAFT_FLUSH_INTERVAL_MS);
    }
  }
  async finishAssistantAttempt(context, status, message, plans = []) {
    this.ensureOpen();
    if (message) validateMessage(message, "assistant");
    const pending = this.activeDrafts.get(draftKey(context)) ?? this.assistantAttempts.get(draftKey(context));
    if (pending?.timer !== void 0) clearTimeout(pending.timer);
    if (pending) pending.timer = void 0;
    const frozenContext = { ...context, createdAt: context.createdAt ?? pending?.createdAt ?? Date.now(), completedAt: context.completedAt ?? Date.now() };
    const copy = cloneMessage(message ?? pending?.message ?? { role: "assistant", content: "" });
    const planCopy = JSON.parse(JSON.stringify(plans));
    return this.enqueueResult(() => {
      const draft = this.prepareDraft(frozenContext);
      if (draft.terminal && (draft.finalStatus !== status || !jsonEqual(draft.message, copy) || !jsonEqual(draft.plans, planCopy))) {
        throw new RepositoryError(`Assistant terminal content changed for attempt ${draft.key}.`, "conflict");
      }
      this.prepareTerminal(draft, status, copy, planCopy, frozenContext.completedAt);
      return this.commitDraft(draft);
    });
  }
  commitToolResult(message, context) {
    validateMessage(message, "tool");
    this.ensureOpen();
    if (!message.toolCallId || message.toolCallId !== context.toolCallId) {
      return Promise.reject(new RepositoryError(`Tool result does not match ${context.toolCallId}.`, "invalid"));
    }
    const key = toolEntryKey(context.runId, context.toolCallId);
    const copy = cloneMessage(message);
    return this.enqueueResult(async () => {
      const previous = this.toolEntries.get(key);
      if (previous) {
        if (context.entryId !== void 0 && previous.id !== context.entryId) {
          throw new RepositoryError(`Tool result entry ID changed for run ${context.runId}, call ${context.toolCallId}.`, "conflict");
        }
        if (previous.turnId !== context.turnId || !jsonEqual(previous.payload, copy)) {
          throw new RepositoryError(`Tool result already exists with different content for run ${context.runId}, call ${context.toolCallId}.`, "conflict");
        }
        if (context.invocationId === void 0) return;
      }
      const entryId = previous?.id ?? context.entryId ?? randomUUID();
      const entry = await this.repository.commitToolResult(this.projectId, {
        id: entryId,
        type: "tool_result",
        status: "completed",
        runId: context.runId,
        turnId: context.turnId,
        toolCallId: context.toolCallId,
        payload: copy,
        createdAt: previous?.createdAt ?? context.createdAt,
        completedAt: previous?.completedAt ?? context.completedAt
      }, context.invocationId);
      this.toolEntries.set(key, entry);
      this.appendCompletedEntry(entry);
    });
  }
  registerToolInvocation(input) {
    this.ensureOpen();
    return this.enqueueResult(() => this.repository.registerToolInvocation({ ...input, projectId: this.projectId }));
  }
  requestRunCancellation(runId) {
    this.ensureOpen();
    return this.repository.requestRunCancellation(this.projectId, runId);
  }
  isRunCancelled(runId) {
    this.ensureOpen();
    return this.repository.isRunCancelled(this.projectId, runId);
  }
  isToolInvocationBlocked(invocationId) {
    this.ensureOpen();
    return this.writeChain.then(() => this.repository.isToolInvocationBlocked(invocationId));
  }
  getToolInvocationCall(invocationId) {
    this.ensureOpen();
    return this.writeChain.then(() => this.repository.getToolInvocationCall(invocationId));
  }
  beginToolAttempt(invocationId, checkpoint) {
    this.ensureOpen();
    return this.enqueueResult(() => this.repository.beginToolAttempt(invocationId, checkpoint));
  }
  saveToolOutcome(invocationId, outcome) {
    this.ensureOpen();
    return this.enqueueResult(() => this.repository.saveToolOutcome(invocationId, outcome));
  }
  settleUnstartedToolInvocation(invocationId, outcome) {
    this.ensureOpen();
    return this.enqueueResult(() => this.repository.settleUnstartedToolInvocation(invocationId, outcome));
  }
  getToolInvocation(runId, toolCallId) {
    this.ensureOpen();
    return this.waitForWrites().then(() => this.repository.getToolInvocation(this.projectId, runId, toolCallId));
  }
  listOpenToolInvocations(runId) {
    this.ensureOpen();
    return this.writeChain.then(() => this.repository.listOpenToolInvocations(this.projectId, runId));
  }
  async finishRun(result) {
    this.ensureOpen();
    for (const draft of this.activeDrafts.values()) {
      if (draft.runId !== result.runId) continue;
      if (draft.timer !== void 0) clearTimeout(draft.timer);
      draft.timer = void 0;
      await this.enqueueResult(() => {
        if (this.activeDrafts.get(draft.key) !== draft) return Promise.resolve([]);
        this.prepareTerminal(draft, result.status === "completed" ? "completed" : result.status === "cancelled" ? "interrupted" : "failed", draft.message, result.status === "completed" ? draft.plans : []);
        return this.commitDraft(draft);
      });
    }
    await this.waitForWrites();
  }
  async close() {
    if (this.closed) return;
    for (const draft of this.activeDrafts.values()) {
      if (draft.timer !== void 0) clearTimeout(draft.timer);
      draft.timer = void 0;
      await this.enqueueResult(() => {
        if (this.activeDrafts.get(draft.key) !== draft) return Promise.resolve([]);
        this.prepareTerminal(draft, "interrupted", draft.message, []);
        return this.commitDraft(draft);
      });
    }
    await this.waitForWrites();
    this.closed = true;
  }
  scheduleFlush(draft, immediate) {
    if (draft.timer !== void 0) {
      clearTimeout(draft.timer);
      draft.timer = void 0;
    }
    if (immediate) void this.enqueueResult(() => this.flushDraft(draft)).catch(() => void 0);
  }
  prepareDraft(context) {
    const key = draftKey(context);
    const existing = this.activeDrafts.get(key) ?? this.assistantAttempts.get(key);
    if (existing) {
      if (existing.runId !== context.runId || existing.turnOrdinal !== context.turnOrdinal || existing.contextEntryId !== void 0 && context.entryId !== void 0 && existing.contextEntryId !== context.entryId) {
        throw new RepositoryError(`Assistant attempt identity changed: ${key}.`, "conflict");
      }
      existing.contextEntryId ??= context.entryId;
      return existing;
    }
    const draft = {
      key,
      entryId: context.entryId ?? randomUUID(),
      contextEntryId: context.entryId,
      runId: context.runId,
      turnId: context.turnId,
      turnOrdinal: context.turnOrdinal,
      attempt: context.attempt ?? 1,
      createdAt: context.createdAt ?? Date.now(),
      message: { role: "assistant", content: "" },
      revision: null,
      pendingBytes: 0,
      dirty: false,
      timer: void 0,
      terminal: false,
      plans: []
    };
    this.activeDrafts.set(key, draft);
    return draft;
  }
  async commitDraft(draft) {
    const savedAttempt = this.assistantAttempts.has(draft.key);
    let committedEntry;
    try {
      const previousId = this.assistantEntries.get(draft.turnId);
      const previous = draft.revision === null && previousId ? await this.repository.getEntry(previousId) : null;
      if (previous?.status === "completed") committedEntry = previous;
      if (previous) {
        if (previous.projectId !== this.projectId || previous.runId !== draft.runId || previous.turnId !== draft.turnId) {
          throw new RepositoryError(`Assistant attempt belongs to a different identity: ${draft.key}.`, "conflict");
        }
        if (previous.status === "completed") {
          if (previous.status !== draft.finalStatus || !jsonEqual(previous.payload, draft.message)) {
            throw new RepositoryError(`Assistant attempt already exists with different content: ${draft.key}.`, "conflict");
          }
          draft.entryId = previous.id;
          draft.revision = null;
          draft.createdAt = previous.createdAt;
          draft.completedAt = previous.completedAt ?? void 0;
        }
      }
      const result = await this.repository.commitAssistantAttempt(this.projectId, {
        entry: {
          id: draft.entryId,
          type: "assistant_message",
          status: draft.finalStatus,
          runId: draft.runId,
          turnId: draft.turnId,
          payload: cloneMessage(draft.message),
          createdAt: draft.createdAt,
          completedAt: draft.finalStatus === "completed" ? draft.completedAt : null
        },
        expectedRevision: draft.revision
      }, draft.plans);
      draft.entryId = result.assistant.id;
      draft.revision = result.assistant.revision;
      draft.dirty = false;
      this.assistantEntries.set(draft.turnId, result.assistant.id);
      this.assistantAttempts.set(draft.key, draft);
      this.appendCompletedEntry(result.assistant);
      this.activeDrafts.delete(draft.key);
      this.draftErrors.delete(draft.key);
      return result.invocations;
    } catch (error) {
      if (savedAttempt || committedEntry) {
        this.activeDrafts.delete(draft.key);
        this.draftErrors.delete(draft.key);
      } else this.draftErrors.set(draft.key, error);
      throw error;
    }
  }
  prepareTerminal(draft, status, message, plans, completedAt = Date.now()) {
    if (draft.timer !== void 0) clearTimeout(draft.timer);
    draft.timer = void 0;
    draft.message = message;
    draft.plans = plans;
    draft.terminal = true;
    draft.dirty = true;
    draft.finalStatus = status;
    if (status === "completed") draft.completedAt ??= completedAt;
  }
  async flushDraft(draft) {
    if (draft.terminal || !draft.dirty) return;
    const message = cloneMessage(draft.message);
    const pendingBytes = draft.pendingBytes;
    let entry;
    try {
      if (draft.revision === null) {
        entry = await this.repository.appendEntry(this.projectId, {
          id: draft.entryId,
          type: "assistant_message",
          status: "streaming",
          runId: draft.runId,
          turnId: draft.turnId,
          payload: message,
          createdAt: draft.createdAt
        });
      } else {
        entry = await this.repository.updateEntry(draft.entryId, draft.revision, {
          status: "streaming",
          payload: message
        });
      }
    } catch (error) {
      this.draftErrors.set(draft.key, error);
      throw error;
    }
    this.draftErrors.delete(draft.key);
    draft.revision = entry.revision;
    this.assistantEntries.set(draft.turnId, entry.id);
    draft.pendingBytes -= pendingBytes;
    draft.dirty = draft.terminal || !jsonEqual(draft.message, message);
  }
  appendCompletedEntry(entry) {
    if (entry.status !== "completed" || this.completedEntryIds.has(entry.id)) return;
    this.completedEntryIds.add(entry.id);
    this.completedMessages.push(cloneMessage(entry.payload));
  }
  enqueueResult(operation) {
    const next = this.writeChain.then(operation, operation);
    this.writeChain = next.then(() => void 0, () => void 0);
    return next;
  }
  async waitForWrites() {
    await this.writeChain;
    if (this.draftErrors.size > 0) throw this.draftErrors.values().next().value;
  }
  ensureOpen() {
    if (this.closed) throw new RepositoryError("History recorder is closed.", "storage");
  }
}
async function readAllEntries(repository, projectId) {
  const entries = [];
  let cursor = 0;
  while (true) {
    const batch = await repository.listEntries(projectId, cursor, 500);
    entries.push(...batch);
    if (batch.length < 500) return entries;
    cursor = batch[batch.length - 1].entryOrder;
  }
}
const recoveryByRepository = /* @__PURE__ */ new WeakMap();
async function recoverAcceptedInputsOnce(repository) {
  let recovery = recoveryByRepository.get(repository);
  if (!recovery) {
    recovery = repository.recoverAcceptedRunInputs("startup_recovery").then(() => void 0);
    recoveryByRepository.set(repository, recovery);
  }
  try {
    await recovery;
  } catch (error) {
    if (recoveryByRepository.get(repository) === recovery) recoveryByRepository.delete(repository);
    throw error;
  }
}
async function createHistoryRecorder(repository, projectId) {
  await recoverAcceptedInputsOnce(repository);
  const entries = await readAllEntries(repository, projectId);
  for (const entry of entries) {
    if (entry.status !== "streaming") continue;
    await repository.updateEntry(entry.id, entry.revision, { status: "interrupted" });
    entry.status = "interrupted";
    entry.revision += 1;
  }
  return new DefaultHistoryRecorder(projectId, repository, entries);
}
const mainProcessDirectory = fileURLToPath(new URL(".", import.meta.url));
const { name: storageIdentity, productName } = applicationMetadata;
app.setName(storageIdentity);
const userDataDirectory = app.commandLine.getSwitchValue("user-data-dir") || join$1(app.getPath("appData"), storageIdentity);
mkdirSync(userDataDirectory, { recursive: true });
app.setPath("userData", userDataDirectory);
app.setPath("sessionData", userDataDirectory);
function createWindow() {
  const win = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 840,
    minHeight: 560,
    title: productName,
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 16, y: 20 },
    show: false,
    webPreferences: {
      preload: join$1(mainProcessDirectory, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void win.loadFile(join$1(mainProcessDirectory, "../renderer/index.html"));
  }
  win.once("ready-to-show", () => {
    win.show();
  });
  return win;
}
function registerIpc(runner, providers, outputFiles, inputAttachments, canvasContexts, canvasDocuments, canvasEditBridge, projects, historyService, getHistoryRecorder) {
  const discoveryControllers = /* @__PURE__ */ new Map();
  const activatedCanvasProjects = /* @__PURE__ */ new Set([projects.activeScope]);
  ipcMain.handle(IPC.run, async (event, req) => {
    try {
      const task = req.task.trim();
      const active = await projects.getActiveContext();
      const projectId = projects.activeScope;
      if (req.projectId !== void 0 && req.projectId !== projectId) return { ok: false, error: "The selected project changed. Choose the project again." };
      const cwd = active.cwd;
      const modelOptionId = req.modelOptionId.trim();
      if (!task) return { ok: false, error: "Enter a task." };
      if (!modelOptionId) return { ok: false, error: "Choose a model." };
      const attachments = await inputAttachments.resolve(Array.isArray(req.attachmentIds) ? req.attachmentIds : []);
      const resolved = await providers.resolve(modelOptionId);
      const runId = randomUUID();
      const canvasContextIds = Array.isArray(req.canvasContextIds) ? req.canvasContextIds.filter((id) => typeof id === "string") : [];
      const resolvedCanvasContexts = canvasContexts.peekMany(canvasContextIds, projectId);
      const historyRecorder = await getHistoryRecorder(projectId);
      const inputId = randomUUID();
      const createdAt = Date.now();
      if (projects.activeScope !== projectId) {
        return { ok: false, error: "The selected project changed. Send the task again." };
      }
      const handle = runner.start({
        task: composeTaskWithAttachments(task, attachments),
        cwd,
        projectId,
        projectContextVersion: active.contextVersion,
        historyRecorder,
        runId,
        initialUserEntryId: inputId,
        initialUserCreatedAt: createdAt,
        ownerWebContentsId: event.sender.id,
        runScopedContext: active.projectContext,
        canvasContexts: resolvedCanvasContexts,
        attachments,
        ...resolved
      }, (payload) => {
        const win = BrowserWindow.fromWebContents(event.sender);
        if (win && !win.isDestroyed()) win.webContents.send(IPC.event, payload);
      });
      canvasContexts.consumeMany(canvasContextIds);
      return { ok: true, runId: handle.runId, inputId, createdAt };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });
  ipcMain.handle(IPC.steer, async (event, request) => {
    try {
      if (!request || typeof request !== "object" || typeof request.runId !== "string" || typeof request.inputId !== "string" || typeof request.task !== "string" || request.projectId !== null && typeof request.projectId !== "string") {
        return { ok: false, error: "The steering input format is invalid." };
      }
      const accepted = await runner.steer(request, event.sender.id);
      return {
        ok: true,
        runId: accepted.runId,
        projectId: accepted.projectId,
        inputId: accepted.inputId,
        acceptOrder: accepted.acceptOrder,
        acceptedAt: accepted.acceptedAt
      };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });
  ipcMain.on(IPC.stop, (event) => {
    runner.stop(event.sender.id);
  });
  ipcMain.handle(IPC.loadHistoryPage, async (_event, request) => {
    return historyService.loadPage(request);
  });
  ipcMain.handle(IPC.getActiveProject, async () => {
    return (await projects.getActiveContext()).descriptor;
  });
  ipcMain.handle(IPC.selectProject, async (event) => {
    if (runner.isActive) throw new Error("Choose a project after the current run finishes.");
    const win = BrowserWindow.fromWebContents(event.sender) ?? BrowserWindow.getFocusedWindow();
    if (!win) return null;
    const result = await dialog.showOpenDialog(win, { properties: ["openDirectory", "createDirectory"] });
    if (result.canceled || result.filePaths.length === 0) return null;
    const active = await projects.selectPath(result.filePaths[0]);
    activatedCanvasProjects.add(active.descriptor.projectId);
    canvasContexts.clearAll();
    await getHistoryRecorder(active.descriptor.projectId);
    return active.descriptor;
  });
  ipcMain.handle(IPC.clearProject, async () => {
    if (runner.isActive) throw new Error("Clear the project after the current run finishes.");
    const active = projects.clear();
    canvasContexts.clearAll();
    await getHistoryRecorder(null);
    return active.descriptor;
  });
  ipcMain.handle(IPC.listProviderProfiles, async () => {
    return providers.list();
  });
  ipcMain.handle(IPC.discoverProviderModels, async (event, input) => {
    if (!input || typeof input.requestId !== "string" || !input.requestId) {
      return { ok: false, error: "invalid_response", message: "The model discovery request is missing a valid identity." };
    }
    const requestKey = `${event.sender.id}:${input.requestId}`;
    discoveryControllers.get(requestKey)?.abort();
    const controller = new AbortController();
    discoveryControllers.set(requestKey, controller);
    const abortOnDestroyed = () => controller.abort();
    event.sender.once("destroyed", abortOnDestroyed);
    try {
      const connection = await providers.discoveryConnection(input);
      const models = await discoverProviderModels(connection, { signal: controller.signal });
      return { ok: true, models };
    } catch (error) {
      return discoveryErrorResult(error);
    } finally {
      event.sender.removeListener("destroyed", abortOnDestroyed);
      if (discoveryControllers.get(requestKey) === controller) discoveryControllers.delete(requestKey);
    }
  });
  ipcMain.on(IPC.cancelProviderModelDiscovery, (event, requestId) => {
    if (typeof requestId !== "string" || !requestId) return;
    discoveryControllers.get(`${event.sender.id}:${requestId}`)?.abort();
  });
  ipcMain.handle(IPC.refreshProviderModels, async (_event, providerProfileId) => {
    if (runner.isActive) return { ok: false, error: "unsupported", message: "Providers cannot be refreshed while a run is active." };
    if (typeof providerProfileId !== "string" || !providerProfileId) {
      return { ok: false, error: "invalid_response", message: "The provider identity is missing." };
    }
    try {
      const connection = await providers.refreshConnection(providerProfileId);
      const models = await discoverProviderModels(connection);
      return { ok: true, profile: await providers.applyRefresh(providerProfileId, models) };
    } catch (error) {
      return discoveryErrorResult(error);
    }
  });
  ipcMain.handle(IPC.saveProvider, async (_event, input) => {
    if (runner.isActive) return { ok: false, error: "Providers cannot be changed while a run is active." };
    try {
      return { ok: true, profile: await providers.save(input) };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });
  ipcMain.handle(IPC.deleteProvider, async (_event, providerProfileId) => {
    if (runner.isActive) return { ok: false, error: "Providers cannot be deleted while a run is active." };
    try {
      await providers.delete(providerProfileId);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });
  ipcMain.handle(IPC.selectAttachments, async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender) ?? BrowserWindow.getFocusedWindow();
    if (!win) return [];
    const result = await dialog.showOpenDialog(win, { properties: ["openFile", "multiSelections"] });
    return result.canceled ? [] : inputAttachments.register(result.filePaths);
  });
  ipcMain.handle(IPC.loadCanvasDocument, async (_event, projectId) => {
    if (projectId !== projects.activeScope) throw new Error("The selected project changed. Open the canvas again.");
    return canvasDocuments.load(projectId);
  });
  ipcMain.handle(IPC.saveCanvasDocument, async (_event, request) => {
    if (!request || !activatedCanvasProjects.has(request.projectId)) {
      throw new Error("The canvas project identity is invalid.");
    }
    return canvasDocuments.save(request.projectId, request.document, request.expectedVersion);
  });
  ipcMain.handle(IPC.prepareCanvasContext, async (_event, input) => {
    if (!input || input.projectId !== projects.activeScope) {
      throw new Error("The selected project changed. Select the canvas content again.");
    }
    return canvasContexts.prepare(input);
  });
  ipcMain.on(IPC.canvasEditResult, (event, result) => {
    canvasEditBridge.handleResult(event.sender.id, result);
  });
  ipcMain.handle(IPC.previewOutputFile, async (_event, runId, fileId) => {
    if (typeof runId !== "string" || typeof fileId !== "string" || !runId || !fileId) {
      return { ok: false, error: "invalid_request", message: "The output file identity is missing." };
    }
    return outputFiles.preview(runId, fileId);
  });
  ipcMain.handle(IPC.openOutputFile, async (_event, runId, fileId) => {
    if (typeof runId !== "string" || typeof fileId !== "string" || !runId || !fileId) {
      return { ok: false, error: "The output file identity is missing." };
    }
    const record2 = outputFiles.resolveForOpen(runId, fileId);
    if (!record2) return { ok: false, error: "The output file does not exist or is no longer valid." };
    const validated = await validateOutputForOpen(record2);
    if (!validated.ok) return { ok: false, error: validated.error };
    const error = await shell.openPath(validated.path);
    return error ? { ok: false, error } : { ok: true };
  });
}
app.whenReady().then(async () => {
  app.setAboutPanelOptions({ applicationName: productName });
  if (process.platform === "darwin") {
    app.dock?.setIcon(appIconPath);
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      {
        label: productName,
        submenu: [
          { role: "about", label: `About ${productName}` },
          { type: "separator" },
          { role: "services" },
          { type: "separator" },
          { role: "hide", label: `Hide ${productName}` },
          { role: "hideOthers" },
          { role: "unhide" },
          { type: "separator" },
          { role: "quit", label: `Quit ${productName}` }
        ]
      },
      { role: "fileMenu" },
      { role: "editMenu" },
      { role: "viewMenu" },
      { role: "windowMenu" }
    ]));
  }
  const historyRepository = new SqliteHistoryRepository(join$1(app.getPath("userData"), "agent-sessions.sqlite"));
  const projects = new ProjectRegistry(historyRepository);
  const historyService = new HistoryService(() => projects.activeScope, historyRepository);
  const recorders = /* @__PURE__ */ new Map();
  const recorderKey = (projectId) => projectId ?? "__unprojected__";
  const getHistoryRecorder = async (projectId) => {
    const key = recorderKey(projectId);
    const existing = recorders.get(key);
    if (existing) return existing;
    const recorder = await createHistoryRecorder(historyRepository, projectId);
    recorders.set(key, recorder);
    return recorder;
  };
  await getHistoryRecorder(null);
  let closing = false;
  const providers = new ProviderStore(
    join$1(app.getPath("userData"), "provider-profiles.json"),
    {
      available: () => safeStorage.isEncryptionAvailable(),
      encrypt: (secret) => safeStorage.encryptString(secret).toString("base64"),
      decrypt: (payload) => safeStorage.decryptString(Buffer.from(payload, "base64"))
    }
  );
  const outputFiles = new OutputFileRegistry();
  const inputAttachments = new InputAttachmentRegistry();
  const canvasDocuments = new CanvasDocumentStore(app.getPath("userData"));
  const canvasContexts = new CanvasContextRegistry();
  const canvasEditBridge = new CanvasEditBridge({
    sendRequest(ownerWebContentsId, request) {
      const owner = webContents.fromId(ownerWebContentsId);
      if (!owner || owner.isDestroyed()) return false;
      owner.send(IPC.canvasEditRequest, request);
      return true;
    },
    sendCancel(ownerWebContentsId, request) {
      const owner = webContents.fromId(ownerWebContentsId);
      if (owner && !owner.isDestroyed()) owner.send(IPC.canvasEditCancel, request);
    },
    onOwnerDestroyed(ownerWebContentsId, callback) {
      const owner = webContents.fromId(ownerWebContentsId);
      if (!owner || owner.isDestroyed()) {
        callback();
        return () => void 0;
      }
      owner.once("destroyed", callback);
      return () => owner.removeListener("destroyed", callback);
    }
  });
  const canvasCli = new CanvasCliExecutor((ownerWebContentsId, request, signal) => {
    if (projects.activeScope !== request.projectId) {
      throw new CanvasEditBridgeError("canvas_unavailable", "The Canvas project changed before the edit could be applied.");
    }
    return canvasEditBridge.request(ownerWebContentsId, request, signal);
  });
  const runner = new AgentRunner((runId, cwd, artifacts, projectId) => {
    void projects.markContextDirty(projectId);
    return outputFiles.register(runId, cwd, artifacts);
  }, {
    enableCreateWithoutSelection: true,
    execute: (ownerWebContentsId, request, signal) => canvasCli.execute(ownerWebContentsId, request, signal)
  });
  registerIpc(runner, providers, outputFiles, inputAttachments, canvasContexts, canvasDocuments, canvasEditBridge, projects, historyService, getHistoryRecorder);
  createWindow();
  app.on("before-quit", (event) => {
    if (closing) return;
    event.preventDefault();
    closing = true;
    runner.stop();
    canvasCli.dispose();
    canvasEditBridge.dispose();
    void (async () => {
      try {
        await runner.waitForIdle();
        await canvasDocuments.waitForIdle();
        await Promise.all([...recorders.values()].map((recorder) => recorder.close()));
      } finally {
        historyRepository.close();
        app.quit();
      }
    })();
  });
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}).catch((error) => {
  dialog.showErrorBox("History storage initialization failed", error instanceof Error ? error.message : String(error));
  app.quit();
});
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
export {
  ModelAdapterError as M
};
