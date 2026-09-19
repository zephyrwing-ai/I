import { app, safeStorage, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { resolve, basename, relative, sep, extname, dirname, isAbsolute, join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { realpath, stat, readFile, open, mkdir, writeFile, rename, opendir, lstat, readdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { Buffer as Buffer$1 } from "node:buffer";
const IPC = {
  run: "agent:run",
  stop: "agent:stop",
  event: "agent:event",
  loadSessionPage: "session:load-page",
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
  previewOutputFile: "output-files:preview",
  openOutputFile: "output-files:open"
};
const MAX_TEXT_BYTES = 512 * 1024;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
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
    const byPath = new Map([...files.values()].map((record) => [record.path, record]));
    const descriptors = [];
    for (const artifact of artifacts) {
      const normalizedPath = resolve(artifact.path);
      const existing = byPath.get(normalizedPath);
      if (artifact.operation === "updated" && !existing) continue;
      const fileId = existing?.descriptor.fileId ?? randomUUID();
      const descriptor = {
        runId,
        fileId,
        name: basename(normalizedPath),
        displayPath: displayPath(cwd, normalizedPath),
        operation: existing ? "updated" : "created",
        mediaType: artifact.mediaType,
        byteSize: artifact.byteSize,
        updatedAt: artifact.updatedAt
      };
      const record = { descriptor, path: normalizedPath };
      files.set(fileId, record);
      byPath.set(normalizedPath, record);
      descriptors.push(descriptor);
    }
    return descriptors;
  }
  async preview(runId, fileId) {
    const record = this.get(runId, fileId);
    if (!record) return failure("not_found", "The output file does not exist or is no longer valid.");
    const verified = await verifyRecord(record);
    if (!verified.ok) return failure("not_found", verified.message);
    const fileStats = verified.stats;
    const updatedAt = fileStats.mtime.toISOString();
    const byteSize = Number(fileStats.size);
    if (IMAGE_MEDIA_TYPES.has(record.descriptor.mediaType)) {
      if (byteSize > MAX_IMAGE_BYTES) return failure("too_large", "The image exceeds 5 MB and cannot be previewed inline.", record.descriptor.mediaType, byteSize);
      try {
        const content = await readFile(record.path);
        return {
          ok: true,
          kind: "image",
          mediaType: record.descriptor.mediaType,
          dataUrl: `data:${record.descriptor.mediaType};base64,${content.toString("base64")}`,
          byteSize,
          updatedAt
        };
      } catch {
        return failure("read_failed", "Failed to read the image.", record.descriptor.mediaType, byteSize);
      }
    }
    if (!isTextMediaType(record.descriptor.mediaType)) {
      return {
        ok: true,
        kind: "unsupported",
        mediaType: record.descriptor.mediaType,
        byteSize,
        updatedAt
      };
    }
    try {
      const size = Math.min(byteSize, MAX_TEXT_BYTES);
      const handle = await open(record.path, "r");
      try {
        const buffer = Buffer.alloc(size);
        const { bytesRead } = await handle.read(buffer, 0, size, 0);
        return {
          ok: true,
          kind: "text",
          mediaType: record.descriptor.mediaType,
          content: buffer.subarray(0, bytesRead).toString("utf8"),
          truncated: byteSize > MAX_TEXT_BYTES,
          byteSize,
          updatedAt
        };
      } finally {
        await handle.close();
      }
    } catch {
      return failure("read_failed", "Failed to read the file.", record.descriptor.mediaType, byteSize);
    }
  }
  resolveForOpen(runId, fileId) {
    return this.get(runId, fileId);
  }
  get(runId, fileId) {
    return this.runs.get(runId)?.get(fileId);
  }
}
async function validateOutputForOpen(record) {
  try {
    const canonical2 = await realpath(record.path);
    if (canonical2 !== record.path) return { ok: false, error: "The output file path has changed." };
    const fileStats = await stat(canonical2);
    if (!fileStats.isFile()) return { ok: false, error: "The output target is no longer a file." };
    return { ok: true, path: canonical2 };
  } catch {
    return { ok: false, error: "The output file does not exist or cannot be accessed." };
  }
}
function displayPath(cwd, path) {
  const relativePath = relative(resolve(cwd), path);
  if (relativePath && relativePath !== ".." && !relativePath.startsWith(`..${sep}`)) return relativePath;
  return path;
}
async function verifyRecord(record) {
  try {
    const canonical2 = await realpath(record.path);
    if (canonical2 !== record.path) return { ok: false, message: "The output file path has changed." };
    const stats = await stat(canonical2);
    if (!stats.isFile()) return { ok: false, message: "The output target is no longer a file." };
    return { ok: true, stats };
  } catch {
    return { ok: false, message: "The output file does not exist or cannot be accessed." };
  }
}
function isTextMediaType(mediaType) {
  return mediaType.startsWith("text/") || mediaType === "application/json" || mediaType === "application/xml" || mediaType === "application/yaml";
}
function failure(error, message, mediaType, byteSize) {
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
      const record = this.records.get(attachmentId);
      if (!record) throw new Error("The attachment does not exist or is no longer valid. Upload it again.");
      try {
        const path = await realpath(record.path);
        const fileStats = await stat(path);
        if (path !== record.path || !fileStats.isFile()) throw new Error();
        attachments.push({ ...record.descriptor, path });
      } catch {
        throw new Error(`The attachment “${record.descriptor.name}” does not exist or cannot be accessed. Upload it again.`);
      }
    }
    return attachments;
  }
}
function composeTaskWithAttachments(task, attachments) {
  if (attachments.length === 0) return task;
  const list = attachments.map((attachment) => `- ${attachment.name}: ${JSON.stringify(attachment.path)}`).join("\n");
  return `${task}

The user attached the following local files. Use the available tools to read them only when relevant to the task:
${list}`;
}
function mediaTypeForPath$1(path) {
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
    const record = item;
    models.push({
      id: typeof record.id === "string" ? record.id : "",
      displayName: firstString(record.display_name, record.name, record.id)
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
      const encryptedApiKey = this.resolveEncryptedSecret(normalized.apiKey, existing);
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
        getApiKey: () => this.requireCredential(profile.providerProfileId)
      };
    }
    throw new Error("The selected model does not exist or is unavailable. Choose another model.");
  }
  async discoveryConnection(input) {
    await this.ensureLoaded();
    const baseURL = normalizeBaseURL(input.baseURL);
    const existing = input.providerProfileId ? this.profiles.find((profile) => profile.providerProfileId === input.providerProfileId) : void 0;
    if (input.providerProfileId && !existing) throw new Error("The provider does not exist or has already been deleted.");
    const apiKey = input.apiKey?.trim() || (existing ? await this.requireCredential(existing.providerProfileId) : "");
    if (!apiKey) throw new Error("Enter an API Key.");
    return { provider: inferProviderFromBaseURL(), baseURL, apiKey };
  }
  async refreshConnection(providerProfileId) {
    await this.ensureLoaded();
    const profile = this.profiles.find((candidate) => candidate.providerProfileId === providerProfileId);
    if (!profile) throw new Error("The provider does not exist or has already been deleted.");
    return { provider: profile.provider, baseURL: profile.baseURL, apiKey: await this.requireCredential(profile.providerProfileId) };
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
  resolveEncryptedSecret(apiKey, existing) {
    if (!apiKey) {
      if (!existing?.encryptedApiKey) throw new Error("A provider requires an API Key.");
      return existing.encryptedApiKey;
    }
    if (!this.codec.available()) throw new Error("System credential encryption is currently unavailable. The API Key was not saved.");
    return this.codec.encrypt(apiKey);
  }
  async requireCredential(providerProfileId) {
    await this.ensureLoaded();
    const profile = this.profiles.find((candidate) => candidate.providerProfileId === providerProfileId);
    if (!profile?.encryptedApiKey) throw new Error("No API Key is configured for this provider. Open Settings and enter one.");
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
  const name = input.name.trim();
  if (!name) throw new Error("Enter a provider name.");
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
    name,
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
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
function toolInputHash(toolName, toolVersion, input) {
  return createHash("sha256").update(`${toolName}
${toolVersion}
${canonicalJson(input)}`, "utf8").digest("hex");
}
function resolveToolPath(value, cwd) {
  return isAbsolute(value) ? value : resolve(cwd, value);
}
function hashText(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
function checkpointForTextFile(path, beforeContent, afterContent, operation, mediaType) {
  const data = {
    path,
    beforeHash: beforeContent === null ? null : hashText(beforeContent),
    afterHash: hashText(afterContent),
    operation,
    mediaType,
    byteSize: Buffer.byteLength(afterContent, "utf8")
  };
  return { version: 1, kind: "text_file", data };
}
async function readTextFileIfPresent(path) {
  try {
    const file = await readFile(path);
    return { exists: true, content: file.toString("utf8") };
  } catch {
    return { exists: false, content: "" };
  }
}
async function reconcileTextFile(checkpoint, context, label) {
  if (!checkpoint || checkpoint.kind !== "text_file" || checkpoint.version !== 1) {
    return { kind: "interrupted", reason: `${label} recovery checkpoint is unavailable or unsupported.` };
  }
  const data = checkpoint.data;
  let current;
  try {
    current = await readTextFileIfPresent(data.path);
    if (current.exists) await stat(data.path);
  } catch {
    return { kind: "interrupted", reason: `${label} recovery could not inspect ${data.path}.` };
  }
  const currentHash = current.exists ? hashText(current.content) : null;
  if (currentHash === data.afterHash) {
    const result = {
      ok: true,
      output: `${label} was already applied and its result was recovered: ${data.path}`,
      returncode: 0,
      truncated: false,
      artifacts: [{
        path: data.path,
        operation: data.operation,
        mediaType: data.mediaType,
        byteSize: data.byteSize,
        updatedAt: (/* @__PURE__ */ new Date()).toISOString()
      }]
    };
    return { kind: "succeeded", result };
  }
  if (currentHash === data.beforeHash) return { kind: "retry", reason: `${label} was not published; retrying from the recorded before state.` };
  return { kind: "interrupted", reason: `${label} target differs from both recorded before and after states: ${data.path}` };
}
const DEFAULT_MODEL_RETRY = {
  maxAttempts: 3,
  baseDelayMs: 1e3,
  maxDelayMs: 8e3
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
  const startedAt = (/* @__PURE__ */ new Date()).toISOString();
  const messages = [...config.recorder?.snapshot() ?? []];
  const userMessage = { role: "user", content: task };
  const tools = [...config.tools.values()].map((tool) => tool.definition);
  const retryConfig = { ...DEFAULT_MODEL_RETRY, ...config.modelRetry };
  let turnOrdinal = 0;
  let currentTurnId;
  let attempt = 0;
  let finished = false;
  const finish = async (status, error) => {
    if (finished) return { runId: config.runId, status, error, turnCount: turnOrdinal };
    let finalStatus = status;
    let finalError = error;
    try {
      await config.recorder?.finishRun({ runId: config.runId, status });
    } catch (finishError) {
      finalStatus = "failed";
      finalError = toAgentError(finishError);
    }
    const result = { runId: config.runId, status: finalStatus, error: finalError, turnCount: turnOrdinal };
    finished = true;
    events.onRunCompleted?.(result);
    return result;
  };
  try {
    await recoverOpenToolInvocations(config, messages);
    if (config.recorder) messages.splice(0, messages.length, ...config.recorder.snapshot());
  } catch (error) {
    return finish("failed", toAgentError(error));
  }
  try {
    await config.recorder?.commitUser(userMessage, { runId: config.runId });
  } catch (error) {
    return finish("failed", toAgentError(error));
  }
  messages.push(...config.runScopedContext ?? [], userMessage);
  events.onRunStart?.({ runId: config.runId, startedAt });
  while (true) {
    if (config.signal?.aborted) return finish("cancelled");
    if (!currentTurnId) {
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
      try {
        await config.recorder?.finishAssistantAttempt(ctx, "completed", message);
      } catch (error) {
        return finish("failed", toAgentError(error));
      }
      messages.push(message);
      events.onAssistantCompleted?.(outcome.response, ctx);
      if (outcome.kind === "answer") {
        events.onTurnCompleted?.(ctx);
        return finish("completed");
      }
      let invocations;
      try {
        invocations = await registerToolBatch(outcome.response.toolCalls, ctx, config);
      } catch (error) {
        return finish("failed", toAgentError(error));
      }
      for (const call of outcome.response.toolCalls) {
        if (config.signal?.aborted) return finish("cancelled");
        events.onToolStart?.(call, ctx);
        const invocation = invocations.get(call.id);
        let executionInvocation = invocation;
        let toolResult;
        if (invocation?.phase === "completed" || invocation?.phase === "outcome_ready") {
          toolResult = toolResultFromInvocation(invocation);
        } else {
          const recovered = invocation?.phase === "effect_pending" ? await recoverToolInvocation(call, invocation, config) : void 0;
          if (recovered?.kind === "succeeded") toolResult = recovered.result;
          else if (recovered?.kind === "interrupted") toolResult = recovered.result ?? interruptedToolResult(recovered.reason);
          else {
            if (invocation && config.recorder) executionInvocation = await config.recorder.beginToolAttempt(invocation.id);
            try {
              toolResult = await executeTool(call, config.tools, executionInvocation?.cwd ?? config.cwd, config.signal, executionInvocation);
            } catch (error) {
              toolResult = interruptedToolResult(error instanceof Error ? error.message : String(error));
            }
          }
        }
        const toolMessage = { role: "tool", content: formatToolResult(toolResult), toolCallId: call.id, toolName: call.name, isError: !toolResult.ok, media: toolResult.media };
        const resultEntryId = executionInvocation?.resultEntryId ?? randomUUID();
        try {
          if (executionInvocation && config.recorder) {
            await config.recorder.saveToolOutcome(executionInvocation.id, {
              status: toolOutcomeStatus(toolResult),
              outcome: toolResult
            });
          }
          await config.recorder?.commitToolResult(toolMessage, { ...ctx, toolCallId: call.id, entryId: resultEntryId });
          if (executionInvocation && config.recorder) await config.recorder.completeToolInvocation(executionInvocation.id, resultEntryId);
        } catch (error) {
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
  if (delayMs <= 0) return Promise.resolve(!signal?.aborted);
  return new Promise((resolve2) => {
    let settled = false;
    const onAbort = () => finish(false);
    const finish = (value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      resolve2(value);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    setTimeout(() => finish(!signal?.aborted), delayMs);
  });
}
async function recoverOpenToolInvocations(config, messages) {
  const recorder = config.recorder;
  if (!recorder || typeof recorder.listOpenToolInvocations !== "function") return;
  const records = await recorder.listOpenToolInvocations(recorder.sessionId);
  for (const invocation of records) {
    if (invocation.phase === "completed") continue;
    let input;
    try {
      const parsed = JSON.parse(invocation.inputJson);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Tool input must be an object.");
      input = parsed;
    } catch (error) {
      const result = interruptedToolResult(error instanceof Error ? error.message : String(error));
      await recorder.saveToolOutcome(invocation.id, { status: "interrupted", outcome: result });
      continue;
    }
    const call = { id: invocation.toolCallId, name: invocation.toolName, input, inputComplete: true };
    let executionInvocation = invocation;
    let toolResult;
    if (invocation.phase === "outcome_ready") {
      toolResult = toolResultFromInvocation(invocation);
    } else {
      const recovered = invocation.phase === "effect_pending" ? await recoverToolInvocation(call, invocation, config) : void 0;
      if (recovered?.kind === "succeeded") toolResult = recovered.result;
      else if (recovered?.kind === "interrupted") toolResult = recovered.result ?? interruptedToolResult(recovered.reason);
      else {
        executionInvocation = await recorder.beginToolAttempt(invocation.id);
        try {
          toolResult = await executeTool(call, config.tools, executionInvocation.cwd, config.signal, executionInvocation);
        } catch (error) {
          toolResult = interruptedToolResult(error instanceof Error ? error.message : String(error));
        }
      }
    }
    const toolMessage = {
      role: "tool",
      content: formatToolResult(toolResult),
      toolCallId: call.id,
      toolName: call.name,
      isError: !toolResult.ok,
      media: toolResult.media
    };
    const resultEntryId = executionInvocation.resultEntryId ?? randomUUID();
    await recorder.saveToolOutcome(executionInvocation.id, { status: toolOutcomeStatus(toolResult), outcome: toolResult });
    await recorder.commitToolResult(toolMessage, {
      runId: invocation.runId,
      turnId: invocation.turnId,
      turnOrdinal: invocation.ordinal,
      toolCallId: call.id,
      entryId: resultEntryId
    });
    await recorder.completeToolInvocation(executionInvocation.id, resultEntryId);
    if (!messages.some((message) => message.role === "tool" && message.toolCallId === call.id)) messages.push(toolMessage);
  }
}
async function registerToolBatch(calls, ctx, config) {
  const records = /* @__PURE__ */ new Map();
  const recorder = config.recorder;
  if (!recorder || typeof recorder.registerToolInvocation !== "function" || typeof recorder.getToolInvocation !== "function") return records;
  for (const [ordinal, call] of calls.entries()) {
    const existing = await recorder.getToolInvocation(recorder.sessionId, call.id);
    const tool = config.tools.get(call.name);
    const toolVersion = tool?.recovery.version ?? "unknown";
    const recoveryMode = tool?.recovery.mode ?? "never";
    const inputJson = canonicalJson(call.input);
    const inputHash = toolInputHash(call.name, toolVersion, call.input);
    if (existing) {
      if (existing.inputHash !== inputHash || existing.toolName !== call.name) throw new Error(`Tool call identity conflict: ${call.id}`);
      records.set(call.id, existing);
      continue;
    }
    const checkpoint = tool?.recovery.prepare ? await tool.recovery.prepare(call.input, { cwd: config.cwd, toolCallId: call.id }) : void 0;
    const assistantEntryId = await recorder.getAssistantEntryId?.(ctx.turnId) ?? `${ctx.turnId}:assistant:${ctx.attempt}`;
    const record = await recorder.registerToolInvocation({
      runId: ctx.runId,
      turnId: ctx.turnId,
      cwd: config.cwd,
      assistantEntryId,
      toolCallId: call.id,
      ordinal,
      toolName: call.name,
      toolVersion,
      inputJson,
      inputHash,
      recoveryModeSnapshot: recoveryMode,
      resultEntryId: randomUUID(),
      checkpoint
    });
    records.set(call.id, record);
  }
  return records;
}
async function recoverToolInvocation(call, invocation, config) {
  const tool = config.tools.get(call.name);
  if (!tool || !config.recorder) return { kind: "interrupted", reason: `Tool ${call.name} is unavailable during recovery.` };
  if (invocation.phase !== "effect_pending") return void 0;
  if (tool.recovery.version !== invocation.toolVersion) {
    return { kind: "interrupted", reason: `Tool ${call.name} version ${invocation.toolVersion} requires a matching recovery implementation.` };
  }
  if (invocation.recoveryModeSnapshot === "never") return { kind: "interrupted", reason: `Tool ${call.name} requires manual recovery after an interrupted execution.` };
  if (invocation.recoveryModeSnapshot === "reconcile" && !tool.recovery.reconcile) {
    return { kind: "interrupted", reason: `Tool ${call.name} has no recovery reconciler.` };
  }
  if (invocation.recoveryModeSnapshot === "reconcile" && tool.recovery.reconcile) {
    const recovered = await tool.recovery.reconcile(call.input, invocation.checkpoint, {
      cwd: invocation.cwd,
      signal: config.signal,
      invocationId: invocation.id,
      toolCallId: call.id,
      attempt: invocation.attemptCount,
      checkpoint: invocation.checkpoint
    });
    if (recovered.kind !== "retry") return recovered;
  }
  return { kind: "retry", reason: "tool recovery permits another execution attempt" };
}
function toolResultFromInvocation(invocation) {
  const outcome = invocation.outcomeJson;
  if (outcome && typeof outcome === "object" && "ok" in outcome && "output" in outcome) return outcome;
  return interruptedToolResult("The persisted tool outcome is missing or invalid.");
}
function interruptedToolResult(reason) {
  return { ok: false, output: reason, returncode: -1, truncated: false, error: "interrupted" };
}
function toolOutcomeStatus(result) {
  return result.error === "interrupted" ? "interrupted" : result.ok ? "succeeded" : "failed";
}
async function executeTool(call, tools, cwd, signal, invocation) {
  if (!call.inputComplete) return invalidResult("The tool arguments were truncated by the model response and were not executed. Please regenerate the complete tool call.", "truncated_arguments");
  const tool = tools.get(call.name);
  if (!tool) return invalidResult(`Unknown tool: ${call.name}`, "unknown_tool");
  return tool.execute(call.input, {
    cwd,
    signal,
    invocationId: invocation?.id,
    toolCallId: call.id,
    attempt: invocation?.attemptCount,
    checkpoint: invocation?.checkpoint
  });
}
function invalidResult(output, error) {
  return { ok: false, output, returncode: -1, truncated: false, error };
}
function formatToolResult(result) {
  const note = result.truncated && result.fullOutputPath ? `
Full output: ${result.fullOutputPath}` : "";
  return `<returncode>${result.returncode}</returncode>
<output>
${result.output}
</output>${note}`;
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
        const dir = mkdtempSync(join(tmpdir(), "ts-agent-"));
        const fullPath = join(dir, "full_output.log");
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
        const entryPath = join(current.path, entry.name);
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
const MAX_LINE_DISPLAY$1 = 2e3;
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
        const display = line.length > MAX_LINE_DISPLAY$1 ? `${line.slice(0, MAX_LINE_DISPLAY$1)} …(Line too long; truncated)` : line;
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
      async prepare(input, context) {
        if (typeof input.path !== "string" || typeof input.content !== "string") return void 0;
        const target = resolveToolPath(input.path, context.cwd);
        const previous = await readTextFileIfPresent(target);
        return checkpointForTextFile(target, previous.exists ? previous.content : null, input.content, previous.exists ? "updated" : "created", mediaTypeForPath(target));
      },
      reconcile: (input, checkpoint, context) => reconcileTextFile(checkpoint, context, "Write")
    },
    async execute(input, context) {
      if (typeof input.path !== "string" || input.path.trim() === "") {
        return { ok: false, output: "Tool parameter path must be a non-empty string.", returncode: -1, truncated: false, error: "invalid_arguments" };
      }
      if (typeof input.content !== "string") {
        return { ok: false, output: "Tool parameter content must be a non-empty string.", returncode: -1, truncated: false, error: "invalid_arguments" };
      }
      const target = isAbsolute(input.path) ? input.path : resolve(context.cwd, input.path);
      let exists = false;
      try {
        const stats = await stat(target);
        if (stats.isDirectory()) {
          return { ok: false, output: `Target is a directory; Write expects a file: ${input.path}`, returncode: -1, truncated: false, error: "target_is_directory" };
        }
        exists = true;
      } catch {
        exists = false;
      }
      try {
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, input.content, "utf8");
      } catch (error) {
        return { ok: false, output: `Write failed: ${error instanceof Error ? error.message : String(error)}`, returncode: -1, truncated: false, error: "write_failed" };
      }
      const bytes = Buffer.byteLength(input.content, "utf8");
      const rel = relative(context.cwd, target) || target;
      const operation = exists ? "updated" : "created";
      return {
        ok: true,
        output: `Wrote ${rel} (${bytes} bytes, ${operation === "created" ? "created" : "overwritten"})`,
        returncode: 0,
        truncated: false,
        artifacts: [{
          path: target,
          operation,
          mediaType: mediaTypeForPath(target),
          byteSize: bytes,
          updatedAt: (/* @__PURE__ */ new Date()).toISOString()
        }]
      };
    }
  };
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
      prepare: prepareEditCheckpoint,
      reconcile: (input, checkpoint, context) => reconcileTextFile(checkpoint, context, "Edit")
    },
    async execute(input, context) {
      if (typeof input.path !== "string" || input.path.trim() === "") {
        return { ok: false, output: "Tool parameter path must be a non-empty string.", returncode: -1, truncated: false, error: "invalid_arguments" };
      }
      if (!Array.isArray(input.edits) || input.edits.length === 0) {
        return { ok: false, output: "Tool parameter edits must be a non-empty array.", returncode: -1, truncated: false, error: "invalid_arguments" };
      }
      const edits = [];
      for (const [i, item] of input.edits.entries()) {
        const oldText = item.oldText;
        const newText = item.newText;
        if (typeof oldText !== "string" || oldText.length === 0) {
          return { ok: false, output: `Edit ${i + 1}: oldText must be a non-empty string.`, returncode: -1, truncated: false, error: "invalid_arguments" };
        }
        if (typeof newText !== "string") {
          return { ok: false, output: `Edit ${i + 1}: newText must be a string.`, returncode: -1, truncated: false, error: "invalid_arguments" };
        }
        edits.push({ oldText, newText });
      }
      const target = isAbsolute(input.path) ? input.path : resolve(context.cwd, input.path);
      let stats;
      try {
        stats = await stat(target);
      } catch {
        return { ok: false, output: `File not found: ${input.path}`, returncode: -1, truncated: false, error: "not_found" };
      }
      if (stats.isDirectory()) {
        return { ok: false, output: `Target is a directory; Edit expects a file: ${input.path}`, returncode: -1, truncated: false, error: "target_is_directory" };
      }
      let original;
      try {
        const buffer = await readFile(target);
        if (buffer.includes(0)) {
          return { ok: false, output: `File is not editable text (contains binary data): ${input.path}`, returncode: -1, truncated: false, error: "binary_file" };
        }
        original = buffer.toString("utf8");
      } catch (error) {
        return { ok: false, output: `Read failed: ${error instanceof Error ? error.message : String(error)}`, returncode: -1, truncated: false, error: "read_failed" };
      }
      const matches = [];
      for (const [order, edit] of edits.entries()) {
        const positions = [];
        for (let at = original.indexOf(edit.oldText); at !== -1; at = original.indexOf(edit.oldText, at + 1)) {
          positions.push(at);
        }
        if (positions.length === 0) {
          return { ok: false, output: `Edit ${order + 1}: oldText was not found in the file: ${JSON.stringify(edit.oldText.slice(0, 200))}`, returncode: -1, truncated: false, error: "text_not_found" };
        }
        if (positions.length > 1) {
          return { ok: false, output: `Edit ${order + 1}: oldText matched ${positions.length} locations; exactly one match is required: ${JSON.stringify(edit.oldText.slice(0, 200))}`, returncode: -1, truncated: false, error: "text_not_unique" };
        }
        matches.push({ index: positions[0], length: edit.oldText.length, edit, order });
      }
      matches.sort((a, b) => a.index - b.index);
      for (let i = 1; i < matches.length; i += 1) {
        const prev = matches[i - 1];
        const curr = matches[i];
        if (curr.index < prev.index + prev.length) {
          return { ok: false, output: `Overlapping edits: ${prev.order + 1} and ${curr.order + 1}`, returncode: -1, truncated: false, error: "edits_overlap" };
        }
      }
      let updated = original;
      for (const match of [...matches].sort((a, b) => b.index - a.index)) {
        updated = updated.slice(0, match.index) + match.edit.newText + updated.slice(match.index + match.length);
      }
      try {
        await writeFile(target, updated, "utf8");
      } catch (error) {
        return { ok: false, output: `Write failed: ${error instanceof Error ? error.message : String(error)}`, returncode: -1, truncated: false, error: "write_failed" };
      }
      const firstLine = (original.slice(0, matches[0].index).match(/\n/g) ?? []).length + 1;
      const rel = relative(context.cwd, target) || target;
      const lines = matches.map((m) => `  #${m.order + 1} line ${(original.slice(0, m.index).match(/\n/g) ?? []).length + 1} ${JSON.stringify(m.edit.oldText.slice(0, 200))} → ${JSON.stringify(m.edit.newText.slice(0, 200))}`).join("\n");
      return {
        ok: true,
        output: `<file>${rel}</file>
Edit count: ${matches.length}
First change: line ${firstLine}
<diff>
${lines}
</diff>`,
        returncode: 0,
        truncated: false,
        artifacts: [{
          path: target,
          operation: "updated",
          mediaType: mediaTypeForPath(target),
          byteSize: Buffer.byteLength(updated, "utf8"),
          updatedAt: (/* @__PURE__ */ new Date()).toISOString()
        }]
      };
    }
  };
}
async function prepareEditCheckpoint(input, context) {
  if (typeof input.path !== "string" || !Array.isArray(input.edits)) return void 0;
  const edits = [];
  for (const item of input.edits) {
    if (!item || typeof item !== "object") return void 0;
    const record = item;
    if (typeof record.oldText !== "string" || record.oldText.length === 0 || typeof record.newText !== "string") return void 0;
    edits.push({ oldText: record.oldText, newText: record.newText });
  }
  const target = resolveToolPath(input.path, context.cwd);
  let original;
  try {
    const buffer = await readFile(target);
    if (buffer.includes(0)) return void 0;
    original = buffer.toString("utf8");
  } catch {
    return void 0;
  }
  const matches = [];
  for (const edit of edits) {
    const positions = [];
    for (let at = original.indexOf(edit.oldText); at !== -1; at = original.indexOf(edit.oldText, at + 1)) positions.push(at);
    if (positions.length !== 1) return void 0;
    matches.push({ index: positions[0], length: edit.oldText.length, edit });
  }
  matches.sort((left, right) => left.index - right.index);
  for (let i = 1; i < matches.length; i += 1) {
    if (matches[i].index < matches[i - 1].index + matches[i - 1].length) return void 0;
  }
  let updated = original;
  for (const match of [...matches].sort((left, right) => right.index - left.index)) {
    updated = updated.slice(0, match.index) + match.edit.newText + updated.slice(match.index + match.length);
  }
  return checkpointForTextFile(target, original, updated, "updated", mediaTypeForPath(target));
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
  description: "Find files whose name or path relative to the search directory contains the pattern (case-insensitive)",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Substring to match against file names or relative paths" },
      path: { type: "string", description: "Search directory, absolute or relative to the workspace root (default workspace root)" },
      limit: { type: "integer", description: "Maximum results (default 100)" }
    },
    required: ["pattern"]
  }
};
const SEARCH_CONTENT_TOOL = {
  name: "search_content",
  description: "Search lines of text files, returning file path, line number and matching lines (respects workspace ignore rules)",
  parameters: {
    type: "object",
    properties: {
      text: { type: "string", description: "Text to search for in file lines (case-insensitive substring)" },
      path: { type: "string", description: "Directory to search, absolute or relative to the workspace root (default workspace root)" },
      types: { type: "array", description: 'File extensions to include (e.g. ["ts", "md"]); all text-typed files by default', items: { type: "string", description: "extension without dot" } },
      caseSensitive: { type: "boolean", description: "Whether the match is case-sensitive (default false)" },
      contextLines: { type: "integer", description: "Lines of context around each match (default 0, max 5)" },
      limit: { type: "integer", description: "Maximum matches (default 100)" }
    },
    required: ["text"]
  }
};
const DEFAULT_LIMIT = 100;
const LIST_DEFAULT_LIMIT = 200;
const LIST_MAX_LIMIT = 1e3;
const MAX_CONTEXT_LINES = 5;
const MAX_SCAN_FILES = 2e4;
const MAX_LINE_DISPLAY = 300;
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
async function* walkFiles(root, signal) {
  const stack = [root];
  let scanned = 0;
  while (stack.length > 0) {
    if (signal?.aborted) return;
    const current = stack.pop();
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (SNAPSHOT_IGNORED_DIRECTORIES.has(entry.name)) continue;
        stack.push(full);
        continue;
      }
      if (!entry.isFile()) continue;
      scanned += 1;
      if (scanned > MAX_SCAN_FILES) return;
      yield full;
    }
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
  let limit = typeof input.limit === "number" && Number.isInteger(input.limit) ? input.limit : DEFAULT_LIMIT;
  limit = Math.min(Math.max(limit, 1), 1e3);
  const needle = input.pattern.toLowerCase();
  const target = toAbs(input.path, context.cwd);
  const { stats, error } = await statOrError(target, input.path);
  if (error) return error;
  if (!stats?.isDirectory()) {
    return fail(`Target is not a directory: ${input.path ?? target}`, "not_a_directory");
  }
  const matches = [];
  for await (const file of walkFiles(target, context.signal)) {
    if (matches.length >= limit) {
      return {
        ok: true,
        output: `<search_root>${relative(context.cwd, target) || "."}</search_root>
${matches.join("\n")}
Found ${limit} matches; the result limit was reached, so not all files may have been searched.`,
        returncode: 0,
        truncated: true
      };
    }
    const relativeToDir = relative(target, file).split(sep).join("/");
    if (relativeToDir.toLowerCase().includes(needle)) {
      matches.push(relativeToDir);
    }
  }
  matches.sort();
  return {
    ok: true,
    output: `<search_root>${relative(context.cwd, target) || "."}</search_root>
${matches.join("\n") || "(No matching files)"}`,
    returncode: 0,
    truncated: false
  };
}
async function searchContent(input, context) {
  if (typeof input.text !== "string" || input.text === "") {
    return fail("Tool parameter text must be a non-empty string.", "invalid_arguments");
  }
  if (input.path !== void 0 && typeof input.path !== "string") {
    return fail("Tool parameter path must be a string.", "invalid_arguments");
  }
  let limit = typeof input.limit === "number" && Number.isInteger(input.limit) ? input.limit : DEFAULT_LIMIT;
  limit = Math.min(Math.max(limit, 1), 1e3);
  const contextLines = Math.min(Math.max(typeof input.contextLines === "number" ? input.contextLines : 0, 0), MAX_CONTEXT_LINES);
  const caseSensitive = input.caseSensitive === true;
  const types = Array.isArray(input.types) ? input.types.filter((t) => typeof t === "string").map((t) => t.toLowerCase().replace(/^\./, "")) : void 0;
  const target = toAbs(input.path, context.cwd);
  const { stats, error } = await statOrError(target, input.path);
  if (error) return error;
  if (!stats?.isDirectory()) {
    return fail(`Target is not a directory: ${input.path ?? target}`, "not_a_directory");
  }
  const needle = caseSensitive ? input.text : input.text.toLowerCase();
  const lines = [];
  let matched = 0;
  let reachedLimit = false;
  let reachedScanCap = false;
  for await (const file of walkFiles(target, context.signal)) {
    if (matched >= limit) {
      reachedLimit = true;
      break;
    }
    if (types) {
      const ext = extname(file).toLowerCase().replace(/^\./, "");
      if (!types.includes(ext)) continue;
    }
    let buffer;
    try {
      buffer = await readFile(file);
    } catch {
      continue;
    }
    if (buffer.includes(0)) continue;
    const text = buffer.toString("utf8");
    const fileLines = text.split("\n");
    for (let i = 0; i < fileLines.length; i += 1) {
      if (matched >= limit) {
        reachedLimit = true;
        break;
      }
      const line = fileLines[i];
      const hay = caseSensitive ? line : line.toLowerCase();
      if (!hay.includes(needle)) continue;
      matched += 1;
      lines.push(`${relative(target, file).split(sep).join("/")}:${i + 1}: ${truncateLine(line)}`);
      if (contextLines > 0) {
        for (let c = Math.max(0, i - contextLines); c <= Math.min(fileLines.length - 1, i + contextLines); c += 1) {
          if (c === i) continue;
          lines.push(`  ${c + 1}: ${truncateLine(fileLines[c])}`);
        }
      }
    }
    if (reachedLimit) break;
  }
  const suffix = [];
  if (reachedLimit) suffix.push(`The match limit of ${limit} was reached; not all files may have been searched.`);
  return {
    ok: true,
    output: `<search_root>${relative(context.cwd, target) || "."}</search_root>
${lines.join("\n") || "(No matching content)"}${suffix.length ? `
${suffix.join("\n")}` : ""}`,
    returncode: 0,
    truncated: reachedLimit || reachedScanCap
  };
}
function truncateLine(line) {
  return line.length > MAX_LINE_DISPLAY ? `${line.slice(0, MAX_LINE_DISPLAY)} …(Line truncated)` : line;
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
const SYSTEM_PROMPT = "You are a coding agent. Use the available tools when needed, then provide a concise final answer.";
class AgentRunner {
  constructor(registerArtifacts, createSessionRecorder2) {
    this.registerArtifacts = registerArtifacts;
    this.createSessionRecorder = createSessionRecorder2;
  }
  registerArtifacts;
  createSessionRecorder;
  controller = new AbortController();
  active = false;
  idleResolvers = /* @__PURE__ */ new Set();
  get isActive() {
    return this.active;
  }
  waitForIdle() {
    if (!this.active) return Promise.resolve();
    return new Promise((resolve2) => this.idleResolvers.add(resolve2));
  }
  start(req, emit) {
    if (this.active) throw new Error("A run is already in progress. Stop the current task first.");
    this.active = true;
    this.controller = new AbortController();
    const runId = req.runId ?? randomUUID();
    if (this.createSessionRecorder && !req.sessionId) {
      this.markIdle();
      throw new Error("The run request is missing a session identity.");
    }
    let recorder;
    try {
      recorder = this.createSessionRecorder?.(req.sessionId, runId);
    } catch (error) {
      this.markIdle();
      throw error;
    }
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
          const files = this.registerArtifacts(ctx.runId, req.cwd, result.artifacts);
          for (const file of files) emitOnce({ type: "outputFileRegistered", runId: ctx.runId, file });
        }
      },
      onTurnRetrying: (ctx) => emitOnce({ type: "turnRetrying", ...ctx }),
      onTurnCompleted: (ctx) => emitOnce({ type: "turnCompleted", ...ctx }),
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
        systemPrompt: SYSTEM_PROMPT,
        cwd: req.cwd,
        tools: createToolRegistry(createLocalBashOps()),
        signal: this.controller.signal,
        recorder,
        runScopedContext: req.runScopedContext?.map(toModelMessage)
      }, events).catch((error) => {
        emitOnce({ type: "runCompleted", runId, status: "failed", turnCount: 0, error: { kind: "runtime", message: error instanceof Error ? error.message : String(error) } });
      });
    });
    return { runId, stop: () => this.controller.abort() };
  }
  stop() {
    if (this.active) this.controller.abort();
  }
  markIdle() {
    if (!this.active) return;
    this.active = false;
    for (const resolve2 of this.idleResolvers) resolve2();
    this.idleResolvers.clear();
  }
}
function toModelMessage(context) {
  return {
    role: "user",
    content: context.text,
    ...context.visual ? { media: { mediaType: context.visual.mediaType, dataUrl: context.visual.dataURL } } : {}
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
const DEFAULT_SESSION_HISTORY_PAGE_LIMIT = 100;
const MAX_SESSION_HISTORY_PAGE_LIMIT = 200;
class SessionHistoryError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
    this.name = "SessionHistoryError";
  }
  code;
}
function normalizePageRequest(request) {
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    throw new SessionHistoryError("The history page request format is invalid.", "invalid_request");
  }
  const candidate = request;
  const cursor = candidate.cursor === void 0 ? null : candidate.cursor;
  if (cursor !== null && (typeof cursor !== "string" || !/^[1-9]\d*$/.test(cursor))) {
    throw new SessionHistoryError("The history page cursor is invalid.", "invalid_request");
  }
  const beforeSeq = cursor === null ? null : Number(cursor);
  if (beforeSeq !== null && !Number.isSafeInteger(beforeSeq)) {
    throw new SessionHistoryError("The history page cursor is outside the safe range.", "invalid_request");
  }
  const limit = candidate.limit ?? DEFAULT_SESSION_HISTORY_PAGE_LIMIT;
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > MAX_SESSION_HISTORY_PAGE_LIMIT) {
    throw new SessionHistoryError(
      `The history page size must be between 1 and ${MAX_SESSION_HISTORY_PAGE_LIMIT}.`,
      "invalid_request"
    );
  }
  return { cursor, beforeSeq, limit };
}
function toHistoryEntry(entry) {
  return {
    entryId: entry.id,
    sessionSeq: entry.sessionSeq,
    type: entry.type,
    status: entry.status,
    runId: entry.runId,
    turnId: entry.turnId,
    toolCallId: entry.toolCallId,
    revision: entry.revision,
    payload: entry.payload,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt
  };
}
class SessionHistoryService {
  constructor(activeSessionId, repository) {
    this.activeSessionId = activeSessionId;
    this.repository = repository;
  }
  activeSessionId;
  repository;
  inFlight = /* @__PURE__ */ new Map();
  async loadPage(request) {
    const normalized = normalizePageRequest(request);
    const requestKey = `${normalized.cursor ?? "latest"}:${normalized.limit}`;
    const existing = this.inFlight.get(requestKey);
    if (existing) return existing;
    const operation = this.readPage(normalized).finally(() => {
      if (this.inFlight.get(requestKey) === operation) this.inFlight.delete(requestKey);
    });
    this.inFlight.set(requestKey, operation);
    return operation;
  }
  async readPage(request) {
    const session = await this.repository.getSession(this.activeSessionId);
    if (!session) throw new SessionHistoryError("The current session does not exist.", "not_found");
    const fetchLimit = request.limit + 1;
    const descendingEntries = request.beforeSeq === null ? await this.repository.listLatestEntries(this.activeSessionId, fetchLimit) : await this.repository.listEntriesBefore(this.activeSessionId, request.beforeSeq, fetchLimit);
    const hasMore = descendingEntries.length > request.limit;
    const pageDescending = hasMore ? descendingEntries.slice(0, request.limit) : descendingEntries;
    const entries = pageDescending.slice().reverse();
    const nextCursor = hasMore && entries.length > 0 ? String(entries[0].sessionSeq) : null;
    if (nextCursor !== null && request.beforeSeq !== null && Number(nextCursor) >= request.beforeSeq) {
      throw new SessionHistoryError("The history page cursor did not advance to older records.", "storage");
    }
    return {
      sessionId: this.activeSessionId,
      entries: entries.map(toHistoryEntry),
      nextCursor,
      hasMore,
      snapshotSeq: Math.max(0, session.nextEntrySeq - 1)
    };
  }
}
const CONTEXT_TTL_MS = 10 * 60 * 1e3;
const MAX_CONTEXT_TEXT = 12e3;
const MAX_CONTEXTS = 32;
class CanvasContextRegistry {
  constructor(documentStore) {
    this.documentStore = documentStore;
  }
  documentStore;
  contexts = /* @__PURE__ */ new Map();
  async load() {
    return this.documentStore.load();
  }
  async save(document) {
    return this.documentStore.save(document);
  }
  async prepare(input) {
    if (input.scope !== "selection" && input.scope !== "document") throw new Error("The canvas context scope is invalid.");
    if (input.visual && (!input.visual.dataURL.startsWith("data:image/png;base64,") || input.visual.dataURL.length > 8 * 1024 * 1024)) {
      throw new Error("The canvas visual snapshot is invalid or too large.");
    }
    const revision = await this.documentStore.save(input.document);
    const allElements = input.document.elements.filter((element) => element.deleted !== true && element.isDeleted !== true);
    const selectedIds = new Set(input.selectedElementIds);
    const elements = input.scope === "selection" ? allElements.filter((element) => typeof element.id === "string" && selectedIds.has(element.id)) : allElements;
    const imageCount = elements.filter((element) => element.type === "image" || typeof element.fileId === "string").length;
    const descriptor = {
      contextId: randomUUID(),
      label: input.scope === "selection" ? `Canvas selection · ${elements.length} elements` : `Canvas · ${elements.length} elements`,
      scope: input.scope,
      elementCount: elements.length,
      imageCount,
      revision,
      hasVisual: Boolean(input.visual)
    };
    const text = summarizeCanvas(elements, revision, input.scope);
    this.contexts.set(descriptor.contextId, {
      context: { descriptor, text, ...input.visual ? { visual: input.visual } : {} },
      expiresAt: Date.now() + CONTEXT_TTL_MS
    });
    this.prune();
    while (this.contexts.size > MAX_CONTEXTS) {
      const oldest = this.contexts.keys().next().value;
      if (!oldest) break;
      this.contexts.delete(oldest);
    }
    return descriptor;
  }
  takeMany(ids) {
    this.prune();
    const unique = [...new Set(ids)];
    const records = unique.map((id) => {
      const record = this.contexts.get(id);
      if (!record) throw new Error("The canvas reference expired. Add it to the message again.");
      return { id, record };
    });
    const contexts = [];
    for (const { id, record } of records) {
      contexts.push(record.context);
      this.contexts.delete(id);
    }
    return contexts;
  }
  prune() {
    const now2 = Date.now();
    for (const [id, record] of this.contexts) if (record.expiresAt <= now2) this.contexts.delete(id);
  }
}
function summarizeCanvas(elements, revision, scope) {
  const lines = [`Canvas context (revision ${revision}, ${scope}).`, "Use this as visual working context for this run only:"];
  const sorted = [...elements].sort((a, b) => numberValue(a.y) - numberValue(b.y) || numberValue(a.x) - numberValue(b.x));
  for (const element of sorted) {
    const type = typeof element.type === "string" ? element.type : "element";
    const id = typeof element.id === "string" ? element.id : "unknown";
    const text = typeof element.text === "string" ? ` text=${JSON.stringify(element.text.slice(0, 1e3))}` : "";
    const label = typeof element.label === "string" ? ` label=${JSON.stringify(element.label.slice(0, 300))}` : "";
    const relation = element.startBinding || element.endBinding ? ` bindings=${JSON.stringify({ start: element.startBinding, end: element.endBinding })}` : "";
    lines.push(`- ${type}#${id}${text}${label}${relation}`);
    if (lines.join("\n").length >= MAX_CONTEXT_TEXT) break;
  }
  return lines.join("\n").slice(0, MAX_CONTEXT_TEXT);
}
function numberValue(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
const MAX_ELEMENTS = 2e4;
const MAX_FILES = 1e3;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
class CanvasDocumentStore {
  directory;
  documentPath;
  revision = 0;
  constructor(userDataPath, sessionId) {
    const safeSessionId = sessionId.replace(/[^a-zA-Z0-9_-]/g, "_");
    this.directory = join(userDataPath, "canvases", safeSessionId);
    this.documentPath = join(this.directory, "scene.json");
  }
  async load() {
    let serialized;
    try {
      serialized = await readFile(this.documentPath, "utf8");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      this.revision = 0;
      return { document: emptyCanvasDocument(), revision: 0 };
    }
    const stored = JSON.parse(serialized);
    const files = {};
    for (const [id, file] of Object.entries(stored.files ?? {})) {
      const assetPath = this.assetPath(id, file.mimeType);
      const asset = await readFile(assetPath);
      files[id] = { ...file, dataURL: toDataURL(file.mimeType, asset) };
    }
    this.revision = Number.isSafeInteger(stored.revision) && stored.revision >= 0 ? stored.revision : 0;
    return {
      document: {
        elements: Array.isArray(stored.elements) ? stored.elements : [],
        appState: isObject(stored.appState) ? stored.appState : {},
        files
      },
      revision: this.revision
    };
  }
  async save(document) {
    validateDocument(document);
    await mkdir(this.directory, { recursive: true });
    const storedFiles = {};
    for (const [id, file] of Object.entries(document.files)) {
      const metadata = {
        id,
        mimeType: file.mimeType,
        created: file.created,
        ...file.lastRetrieved === void 0 ? {} : { lastRetrieved: file.lastRetrieved },
        ...file.version === void 0 ? {} : { version: file.version }
      };
      storedFiles[id] = metadata;
      if (file.dataURL) {
        const bytes = decodeDataURL(file.dataURL, file.mimeType);
        const assetPath = this.assetPath(id, file.mimeType);
        const assetTempPath = `${assetPath}.${process.pid}.tmp`;
        await writeFile(assetTempPath, bytes);
        await rename(assetTempPath, assetPath);
      } else {
        await stat(this.assetPath(id, file.mimeType));
      }
    }
    const nextRevision = this.revision + 1;
    const stored = {
      revision: nextRevision,
      elements: document.elements,
      appState: document.appState,
      files: storedFiles
    };
    const tempPath = `${this.documentPath}.${process.pid}.tmp`;
    await writeFile(tempPath, JSON.stringify(stored), "utf8");
    await rename(tempPath, this.documentPath);
    this.revision = nextRevision;
    return nextRevision;
  }
  assetPath(id, mimeType) {
    const extension = mimeType === "image/jpeg" ? "jpg" : mimeType.split("/")[1]?.replace(/[^a-z0-9]/gi, "") || "bin";
    return join(this.directory, `${id}.${extension}`);
  }
}
function emptyCanvasDocument() {
  return { elements: [], appState: {}, files: {} };
}
function validateDocument(document) {
  if (!document || !Array.isArray(document.elements) || document.elements.length > MAX_ELEMENTS) {
    throw new Error("The canvas scene is invalid or too large.");
  }
  if (!isObject(document.appState) || !isObject(document.files) || Object.keys(document.files).length > MAX_FILES) {
    throw new Error("The canvas state is invalid.");
  }
  for (const [id, file] of Object.entries(document.files)) {
    if (!/^[a-zA-Z0-9_-]+$/.test(id) || !file || !file.mimeType.startsWith("image/")) {
      throw new Error("The canvas contains an unsupported image asset.");
    }
    if (file.dataURL) decodeDataURL(file.dataURL, file.mimeType);
  }
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
const SCHEMA_VERSION = 3;
function initializeSchema(database) {
  database.exec("PRAGMA journal_mode = WAL");
  database.exec("PRAGMA foreign_keys = ON");
  database.exec("PRAGMA synchronous = FULL");
  database.exec("PRAGMA busy_timeout = 5000");
  database.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      scope_key TEXT NOT NULL,
      objective TEXT,
      status TEXT NOT NULL CHECK (status IN ('active', 'waiting', 'closed')),
      next_entry_seq INTEGER NOT NULL DEFAULT 1,
      revision INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS entries (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      session_seq INTEGER NOT NULL,
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
      UNIQUE (session_id, session_seq)
    );

    CREATE INDEX IF NOT EXISTS entries_session_order_idx
      ON entries (session_id, session_seq ASC);
    CREATE INDEX IF NOT EXISTS entries_tool_call_idx
      ON entries (session_id, tool_call_id);

    CREATE TABLE IF NOT EXISTS tool_invocations (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
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
      UNIQUE (session_id, tool_call_id)
    );

    CREATE INDEX IF NOT EXISTS tool_invocations_session_phase_idx
      ON tool_invocations (session_id, phase, ordinal ASC);
  `);
  const current = database.prepare("PRAGMA user_version").get();
  if (Number(current.user_version) === 0 || Number(current.user_version) === 1) {
    database.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    return;
  }
  if (Number(current.user_version) === 2) {
    database.exec("ALTER TABLE tool_invocations ADD COLUMN cwd TEXT NOT NULL DEFAULT ''");
    database.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    return;
  }
  if (Number(current.user_version) !== SCHEMA_VERSION) {
    throw new Error(`Unsupported session storage schema version: ${current.user_version}`);
  }
}
class RepositoryError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
    this.name = "RepositoryError";
  }
  code;
}
function now() {
  return Date.now();
}
function canonical$1(value) {
  if (Array.isArray(value)) return `[${value.map(canonical$1).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${canonical$1(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
function serializeJson(value, field) {
  const serialized = JSON.stringify(value);
  if (serialized === void 0) throw new RepositoryError(`${field} must be JSON serializable.`, "invalid");
  return serialized;
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
  if (!parsed || typeof parsed !== "object" || !["user", "assistant", "tool"].includes(parsed.role) || typeof parsed.content !== "string") {
    throw new RepositoryError("Stored entry payload is not a ModelMessage.", "storage");
  }
  return parsed;
}
function validatePayloadForType(type, payload, toolCallId) {
  const expectedRole = type === "user_message" ? "user" : type === "assistant_message" ? "assistant" : "tool";
  if (payload.role !== expectedRole) throw new RepositoryError(`${type} payload must use role ${expectedRole}.`, "invalid");
  if (type === "tool_result" && !toolCallId) throw new RepositoryError("tool_result requires toolCallId.", "invalid");
}
function rowToSession(row) {
  return {
    id: String(row.id),
    scopeKey: String(row.scope_key),
    objective: row.objective === null || row.objective === void 0 ? null : String(row.objective),
    status: String(row.status),
    nextEntrySeq: Number(row.next_entry_seq),
    revision: Number(row.revision),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at)
  };
}
function rowToEntry(row) {
  return {
    id: String(row.id),
    sessionId: String(row.session_id),
    sessionSeq: Number(row.session_seq),
    type: String(row.type),
    status: String(row.status),
    runId: String(row.run_id),
    turnId: row.turn_id === null || row.turn_id === void 0 ? null : String(row.turn_id),
    toolCallId: row.tool_call_id === null || row.tool_call_id === void 0 ? null : String(row.tool_call_id),
    revision: Number(row.revision),
    payloadVersion: Number(row.payload_version),
    payload: parsePayload(row.payload_json),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at)
  };
}
function rowToToolInvocation(row) {
  return {
    id: String(row.id),
    sessionId: String(row.session_id),
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
class SqliteSessionRepository {
  database;
  constructor(path) {
    this.database = new DatabaseSync(path);
    initializeSchema(this.database);
  }
  async createSession(input) {
    const id = input.id ?? randomUUID();
    const createdAt = input.createdAt ?? now();
    const status = input.status ?? "active";
    const session = {
      id,
      scopeKey: input.scopeKey,
      objective: input.objective ?? null,
      status,
      nextEntrySeq: 1,
      revision: 0,
      createdAt,
      updatedAt: createdAt
    };
    try {
      this.database.prepare(`
        INSERT INTO sessions
          (id, scope_key, objective, status, next_entry_seq, revision, created_at, updated_at)
        VALUES (?, ?, ?, ?, 1, 0, ?, ?)
      `).run(session.id, session.scopeKey, session.objective, session.status, session.createdAt, session.updatedAt);
    } catch (error) {
      throw new RepositoryError(`Failed to create session: ${error instanceof Error ? error.message : String(error)}`, "storage");
    }
    return session;
  }
  async getSession(sessionId) {
    const row = this.database.prepare("SELECT * FROM sessions WHERE id = ?").get(sessionId);
    return row ? rowToSession(row) : null;
  }
  async getLatestOpenSession(scopeKey) {
    const row = this.database.prepare(`
      SELECT * FROM sessions
      WHERE scope_key = ? AND status != 'closed'
      ORDER BY updated_at DESC, created_at DESC, id DESC
      LIMIT 1
    `).get(scopeKey);
    return row ? rowToSession(row) : null;
  }
  async appendEntry(sessionId, entry) {
    validatePayloadForType(entry.type, entry.payload, entry.toolCallId);
    const result = this.transaction(() => {
      const sessionRow = this.database.prepare("SELECT * FROM sessions WHERE id = ?").get(sessionId);
      if (!sessionRow) throw new RepositoryError(`Session not found: ${sessionId}`, "not_found");
      const existingRow = this.database.prepare("SELECT * FROM entries WHERE id = ?").get(entry.id);
      if (existingRow) {
        const existing = rowToEntry(existingRow);
        const same = existing.sessionId === sessionId && existing.type === entry.type && existing.status === entry.status && existing.runId === entry.runId && existing.turnId === (entry.turnId ?? null) && existing.toolCallId === (entry.toolCallId ?? null) && existing.payloadVersion === (entry.payloadVersion ?? 1) && canonical$1(existing.payload) === canonical$1(entry.payload);
        if (same) return existing;
        throw new RepositoryError(`Entry already exists with different content: ${entry.id}`, "conflict");
      }
      const timestamp = entry.createdAt ?? now();
      const updatedAt = entry.updatedAt ?? timestamp;
      const sessionSeq = Number(sessionRow.next_entry_seq);
      this.database.prepare(`
        INSERT INTO entries
          (id, session_id, session_seq, type, status, run_id, turn_id, tool_call_id,
           revision, payload_version, payload_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        entry.id,
        sessionId,
        sessionSeq,
        entry.type,
        entry.status,
        entry.runId,
        entry.turnId ?? null,
        entry.toolCallId ?? null,
        entry.revision ?? 0,
        entry.payloadVersion ?? 1,
        JSON.stringify(entry.payload),
        timestamp,
        updatedAt
      );
      this.database.prepare(`
        UPDATE sessions
        SET next_entry_seq = ?, revision = revision + 1, updated_at = ?
        WHERE id = ?
      `).run(sessionSeq + 1, updatedAt, sessionId);
      const row = this.database.prepare("SELECT * FROM entries WHERE id = ?").get(entry.id);
      return rowToEntry(row);
    });
    return result;
  }
  async updateEntry(entryId, expectedRevision, patch) {
    const result = this.transaction(() => {
      const existingRow = this.database.prepare("SELECT * FROM entries WHERE id = ?").get(entryId);
      if (!existingRow) throw new RepositoryError(`Entry not found: ${entryId}`, "not_found");
      const existing = rowToEntry(existingRow);
      if (existing.revision !== expectedRevision) {
        throw new RepositoryError(`Entry revision conflict: ${entryId}`, "conflict");
      }
      const updatedAt = patch.updatedAt ?? now();
      const nextStatus = patch.status ?? existing.status;
      const nextPayload = patch.payload ?? existing.payload;
      const nextPayloadVersion = patch.payloadVersion ?? existing.payloadVersion;
      const nextTurnId = patch.turnId === void 0 ? existing.turnId : patch.turnId;
      const nextToolCallId = patch.toolCallId === void 0 ? existing.toolCallId : patch.toolCallId;
      validatePayloadForType(existing.type, nextPayload, nextToolCallId);
      this.database.prepare(`
        UPDATE entries
        SET status = ?, turn_id = ?, tool_call_id = ?, revision = revision + 1,
            payload_version = ?, payload_json = ?, updated_at = ?
        WHERE id = ? AND revision = ?
      `).run(
        nextStatus,
        nextTurnId,
        nextToolCallId,
        nextPayloadVersion,
        JSON.stringify(nextPayload),
        updatedAt,
        entryId,
        expectedRevision
      );
      this.database.prepare(`
        UPDATE sessions
        SET revision = revision + 1, updated_at = ?
        WHERE id = ?
      `).run(updatedAt, existing.sessionId);
      const row = this.database.prepare("SELECT * FROM entries WHERE id = ?").get(entryId);
      return rowToEntry(row);
    });
    return result;
  }
  async getEntry(entryId) {
    const row = this.database.prepare("SELECT * FROM entries WHERE id = ?").get(entryId);
    return row ? rowToEntry(row) : null;
  }
  async listEntries(sessionId, cursor = 0, limit = 100) {
    if (!Number.isInteger(cursor) || cursor < 0) throw new RepositoryError("Entry cursor must be a non-negative integer.", "invalid");
    if (!Number.isInteger(limit) || limit <= 0) throw new RepositoryError("Entry limit must be a positive integer.", "invalid");
    const rows = this.database.prepare(`
      SELECT * FROM entries
      WHERE session_id = ? AND session_seq > ?
      ORDER BY session_seq ASC
      LIMIT ?
    `).all(sessionId, cursor, limit);
    return rows.map(rowToEntry);
  }
  async listLatestEntries(sessionId, limit) {
    this.validateHistoryLimit(limit);
    const rows = this.database.prepare(`
      SELECT * FROM entries
      WHERE session_id = ?
      ORDER BY session_seq DESC
      LIMIT ?
    `).all(sessionId, limit);
    return rows.map(rowToEntry);
  }
  async listEntriesBefore(sessionId, beforeSeq, limit) {
    if (!Number.isSafeInteger(beforeSeq) || beforeSeq <= 0) {
      throw new RepositoryError("History cursor must be a positive safe integer.", "invalid");
    }
    this.validateHistoryLimit(limit);
    const rows = this.database.prepare(`
      SELECT * FROM entries
      WHERE session_id = ? AND session_seq < ?
      ORDER BY session_seq DESC
      LIMIT ?
    `).all(sessionId, beforeSeq, limit);
    return rows.map(rowToEntry);
  }
  async registerToolInvocation(input) {
    this.validateToolInvocationInput(input);
    const id = input.id ?? randomUUID();
    const resultEntryId = input.resultEntryId ?? randomUUID();
    const timestamp = input.createdAt ?? now();
    const updatedAt = input.updatedAt ?? timestamp;
    const checkpointJson = input.checkpoint === void 0 ? null : serializeJson(input.checkpoint, "checkpoint");
    return this.transaction(() => {
      const session = this.database.prepare("SELECT id FROM sessions WHERE id = ?").get(input.sessionId);
      if (!session) throw new RepositoryError(`Session not found: ${input.sessionId}`, "not_found");
      try {
        this.database.prepare(`
          INSERT INTO tool_invocations
            (id, session_id, run_id, turn_id, cwd, assistant_entry_id, tool_call_id, ordinal,
             tool_name, tool_version, input_json, input_hash, phase, outcome_status,
             outcome_json, recovery_mode_snapshot, attempt_count, checkpoint_json,
             result_entry_id, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'planned', NULL, NULL, ?, 0, ?, ?, ?, ?)
        `).run(
          id,
          input.sessionId,
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
        throw new RepositoryError(`Failed to register tool invocation: ${error instanceof Error ? error.message : String(error)}`, "conflict");
      }
      this.bumpSession(input.sessionId, updatedAt);
      return this.getToolInvocationById(id);
    });
  }
  async beginToolAttempt(invocationId) {
    return this.transaction(() => {
      const existing = this.getToolInvocationById(invocationId);
      if (!existing) throw new RepositoryError(`Tool invocation not found: ${invocationId}`, "not_found");
      if (existing.phase === "effect_pending") {
        const updatedAt2 = now();
        this.database.prepare(`
          UPDATE tool_invocations
          SET attempt_count = attempt_count + 1, updated_at = ?
          WHERE id = ? AND phase = 'effect_pending'
        `).run(updatedAt2, invocationId);
        this.bumpSession(existing.sessionId, updatedAt2);
        return this.getToolInvocationById(invocationId);
      }
      if (existing.phase !== "planned") {
        throw new RepositoryError(`Tool invocation cannot begin from phase ${existing.phase}: ${invocationId}`, "conflict");
      }
      const updatedAt = now();
      this.database.prepare(`
        UPDATE tool_invocations
        SET phase = 'effect_pending', attempt_count = attempt_count + 1, updated_at = ?
        WHERE id = ? AND phase = 'planned'
      `).run(updatedAt, invocationId);
      this.bumpSession(existing.sessionId, updatedAt);
      return this.getToolInvocationById(invocationId);
    });
  }
  async saveToolOutcome(invocationId, outcome) {
    const outcomeJson = serializeJson(outcome.outcome, "tool outcome");
    const checkpointJson = outcome.checkpoint === void 0 ? null : serializeJson(outcome.checkpoint, "checkpoint");
    return this.transaction(() => {
      const existing = this.getToolInvocationById(invocationId);
      if (!existing) throw new RepositoryError(`Tool invocation not found: ${invocationId}`, "not_found");
      if (existing.phase === "outcome_ready" || existing.phase === "completed") {
        if (existing.outcomeStatus !== outcome.status || canonical$1(existing.outcomeJson) !== canonical$1(outcome.outcome)) {
          throw new RepositoryError(`Tool outcome already exists with different content: ${invocationId}`, "conflict");
        }
        return existing;
      }
      if (existing.phase !== "effect_pending") {
        throw new RepositoryError(`Tool invocation cannot save outcome from phase ${existing.phase}: ${invocationId}`, "conflict");
      }
      const updatedAt = outcome.updatedAt ?? now();
      this.database.prepare(`
        UPDATE tool_invocations
        SET phase = 'outcome_ready', outcome_status = ?, outcome_json = ?,
            checkpoint_json = COALESCE(?, checkpoint_json), updated_at = ?
        WHERE id = ? AND phase = 'effect_pending'
      `).run(outcome.status, outcomeJson, checkpointJson, updatedAt, invocationId);
      this.bumpSession(existing.sessionId, updatedAt);
      return this.getToolInvocationById(invocationId);
    });
  }
  async completeToolInvocation(invocationId, resultEntryId) {
    if (!resultEntryId) throw new RepositoryError("resultEntryId is required.", "invalid");
    return this.transaction(() => {
      const existing = this.getToolInvocationById(invocationId);
      if (!existing) throw new RepositoryError(`Tool invocation not found: ${invocationId}`, "not_found");
      if (existing.phase === "completed") {
        if (existing.resultEntryId !== resultEntryId) throw new RepositoryError(`Tool invocation already completed with a different result: ${invocationId}`, "conflict");
        return existing;
      }
      if (existing.phase !== "outcome_ready") {
        throw new RepositoryError(`Tool invocation cannot complete from phase ${existing.phase}: ${invocationId}`, "conflict");
      }
      const updatedAt = now();
      this.database.prepare(`
        UPDATE tool_invocations
        SET phase = 'completed', result_entry_id = ?, updated_at = ?
        WHERE id = ? AND phase = 'outcome_ready'
      `).run(resultEntryId, updatedAt, invocationId);
      this.bumpSession(existing.sessionId, updatedAt);
      return this.getToolInvocationById(invocationId);
    });
  }
  async getToolInvocation(sessionId, toolCallId) {
    const row = this.database.prepare(`
      SELECT * FROM tool_invocations WHERE session_id = ? AND tool_call_id = ?
    `).get(sessionId, toolCallId);
    return row ? rowToToolInvocation(row) : null;
  }
  async listOpenToolInvocations(sessionId) {
    const rows = this.database.prepare(`
      SELECT * FROM tool_invocations
      WHERE session_id = ? AND phase != 'completed'
      ORDER BY ordinal ASC, created_at ASC, id ASC
    `).all(sessionId);
    return rows.map(rowToToolInvocation);
  }
  async updateSession(sessionId, expectedRevision, patch) {
    const result = this.transaction(() => {
      const existingRow = this.database.prepare("SELECT * FROM sessions WHERE id = ?").get(sessionId);
      if (!existingRow) throw new RepositoryError(`Session not found: ${sessionId}`, "not_found");
      const existing = rowToSession(existingRow);
      if (existing.revision !== expectedRevision) throw new RepositoryError(`Session revision conflict: ${sessionId}`, "conflict");
      const updatedAt = patch.updatedAt ?? now();
      this.database.prepare(`
        UPDATE sessions
        SET objective = ?, status = ?, revision = revision + 1, updated_at = ?
        WHERE id = ? AND revision = ?
      `).run(
        patch.objective === void 0 ? existing.objective : patch.objective,
        patch.status ?? existing.status,
        updatedAt,
        sessionId,
        expectedRevision
      );
      return rowToSession(this.database.prepare("SELECT * FROM sessions WHERE id = ?").get(sessionId));
    });
    return result;
  }
  close() {
    this.database.close();
  }
  transaction(operation) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.database.exec("ROLLBACK");
      } catch {
      }
      throw error;
    }
  }
  validateHistoryLimit(limit) {
    if (!Number.isSafeInteger(limit) || limit <= 0) {
      throw new RepositoryError("History limit must be a positive safe integer.", "invalid");
    }
  }
  validateToolInvocationInput(input) {
    if (!input.runId || !input.turnId || !input.cwd || !input.assistantEntryId || !input.toolCallId || !input.toolName || !input.toolVersion || !input.inputHash) {
      throw new RepositoryError("Tool invocation identity and tool metadata are required.", "invalid");
    }
    if (!Number.isSafeInteger(input.ordinal) || input.ordinal < 0) {
      throw new RepositoryError("Tool invocation ordinal must be a non-negative safe integer.", "invalid");
    }
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
  bumpSession(sessionId, updatedAt) {
    this.database.prepare("UPDATE sessions SET revision = revision + 1, updated_at = ? WHERE id = ?").run(updatedAt, sessionId);
  }
}
const DRAFT_FLUSH_INTERVAL_MS = 500;
const DRAFT_FLUSH_BYTES = 4096;
function cloneMessage(message) {
  return JSON.parse(JSON.stringify(message));
}
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
function isSameMessage(left, right) {
  return canonical(left) === canonical(right);
}
function freezeSnapshot(messages) {
  return messages.map((message) => Object.freeze(cloneMessage(message)));
}
function validateMessage(message, role) {
  if (message.role !== role) throw new RepositoryError(`Expected a ${role} message.`, "invalid");
}
function draftKey(context) {
  return `${context.turnId}:${context.attempt ?? 1}`;
}
class DefaultSessionRecorder {
  sessionId;
  repository;
  completedMessages = [];
  activeDrafts = /* @__PURE__ */ new Map();
  userEntries = /* @__PURE__ */ new Map();
  toolEntries = /* @__PURE__ */ new Map();
  assistantEntries = /* @__PURE__ */ new Map();
  writeChain = Promise.resolve();
  backgroundError;
  closed = false;
  constructor(sessionId, repository, entries = []) {
    this.sessionId = sessionId;
    this.repository = repository;
    for (const entry of [...entries].sort((left, right) => left.sessionSeq - right.sessionSeq)) {
      if (entry.type === "user_message") this.userEntries.set(entry.runId, { entryId: entry.id, message: cloneMessage(entry.payload) });
      if (entry.type === "tool_result" && entry.toolCallId) this.toolEntries.set(entry.toolCallId, { entryId: entry.id, message: cloneMessage(entry.payload) });
      if (entry.type === "assistant_message" && entry.turnId) this.assistantEntries.set(entry.turnId, entry.id);
      if (entry.status === "completed") this.completedMessages.push(cloneMessage(entry.payload));
    }
  }
  snapshot() {
    return freezeSnapshot(this.completedMessages);
  }
  getAssistantEntryId(turnId) {
    return Promise.resolve(this.assistantEntries.get(turnId) ?? null);
  }
  commitUser(message, context) {
    validateMessage(message, "user");
    this.ensureOpen();
    const previous = this.userEntries.get(context.runId);
    if (previous) {
      if (!isSameMessage(previous.message, message)) {
        return Promise.reject(new RepositoryError(`A different user message already belongs to run ${context.runId}.`, "conflict"));
      }
      return this.waitForWrites();
    }
    const entryId = randomUUID();
    const copy = cloneMessage(message);
    this.userEntries.set(context.runId, { entryId, message: copy });
    return this.enqueueAndCheck(async () => {
      const entry = await this.repository.appendEntry(this.sessionId, {
        id: entryId,
        type: "user_message",
        status: "completed",
        runId: context.runId,
        payload: copy
      });
      this.completedMessages.push(cloneMessage(entry.payload));
    });
  }
  recordAssistantDelta(kind, delta, context) {
    this.ensureOpen();
    if (!delta) return;
    const key = draftKey(context);
    let draft = this.activeDrafts.get(key);
    if (!draft) {
      draft = {
        key,
        entryId: randomUUID(),
        runId: context.runId,
        turnId: context.turnId,
        turnOrdinal: context.turnOrdinal,
        attempt: context.attempt ?? 1,
        message: { role: "assistant", content: "" },
        revision: null,
        pendingBytes: 0,
        dirty: false,
        timer: void 0,
        terminal: false
      };
      this.activeDrafts.set(key, draft);
    }
    if (kind === "text") draft.message.content += delta;
    else draft.message.reasoning = (draft.message.reasoning ?? "") + delta;
    draft.pendingBytes += Buffer$1.byteLength(delta, "utf8");
    draft.dirty = true;
    if (draft.pendingBytes >= DRAFT_FLUSH_BYTES) {
      this.scheduleFlush(draft, true);
    } else if (draft.timer === void 0) {
      draft.timer = setTimeout(() => {
        draft.timer = void 0;
        void this.enqueue(() => this.flushDraft(draft));
      }, DRAFT_FLUSH_INTERVAL_MS);
    }
  }
  finishAssistantAttempt(context, status, message) {
    this.ensureOpen();
    const key = draftKey(context);
    let draft = this.activeDrafts.get(key);
    if (message) validateMessage(message, "assistant");
    if (!draft) {
      draft = {
        key,
        entryId: randomUUID(),
        runId: context.runId,
        turnId: context.turnId,
        turnOrdinal: context.turnOrdinal,
        attempt: context.attempt ?? 1,
        message: cloneMessage(message ?? { role: "assistant", content: "" }),
        revision: null,
        pendingBytes: 0,
        dirty: true,
        timer: void 0,
        terminal: true
      };
      this.activeDrafts.set(key, draft);
    } else {
      if (draft.terminal && message && !isSameMessage(draft.message, message)) {
        return Promise.reject(new RepositoryError(`Assistant message already committed for attempt ${key}.`, "conflict"));
      }
      if (draft.terminal) return this.waitForWrites();
      if (message) draft.message = cloneMessage(message);
      draft.dirty = true;
      draft.terminal = true;
      if (draft.timer !== void 0) clearTimeout(draft.timer);
      draft.timer = void 0;
    }
    draft.finalStatus = status;
    return this.enqueueAndCheck(async () => {
      await this.flushDraft(draft);
    });
  }
  commitAssistant(message, context) {
    return this.finishAssistantAttempt(context, "completed", message);
  }
  commitToolResult(message, context) {
    validateMessage(message, "tool");
    this.ensureOpen();
    if (!message.toolCallId || message.toolCallId !== context.toolCallId) {
      return Promise.reject(new RepositoryError(`Tool result does not match ${context.toolCallId}.`, "invalid"));
    }
    const previous = this.toolEntries.get(context.toolCallId);
    if (previous) {
      if (!isSameMessage(previous.message, message)) return Promise.reject(new RepositoryError(`Tool result already exists with different content: ${context.toolCallId}`, "conflict"));
      return this.waitForWrites();
    }
    const entryId = context.entryId ?? randomUUID();
    const copy = cloneMessage(message);
    this.toolEntries.set(context.toolCallId, { entryId, message: copy });
    return this.enqueueAndCheck(async () => {
      const entry = await this.repository.appendEntry(this.sessionId, {
        id: entryId,
        type: "tool_result",
        status: "completed",
        runId: context.runId,
        turnId: context.turnId,
        toolCallId: context.toolCallId,
        payload: copy
      });
      this.completedMessages.push(cloneMessage(entry.payload));
    });
  }
  registerToolInvocation(input) {
    this.ensureOpen();
    return this.enqueueResult(() => this.repository.registerToolInvocation({ ...input, sessionId: this.sessionId }));
  }
  beginToolAttempt(invocationId) {
    this.ensureOpen();
    return this.enqueueResult(() => this.repository.beginToolAttempt(invocationId));
  }
  saveToolOutcome(invocationId, outcome) {
    this.ensureOpen();
    return this.enqueueResult(() => this.repository.saveToolOutcome(invocationId, outcome));
  }
  completeToolInvocation(invocationId, resultEntryId) {
    this.ensureOpen();
    return this.enqueueResult(() => this.repository.completeToolInvocation(invocationId, resultEntryId));
  }
  getToolInvocation(sessionId, toolCallId) {
    this.ensureOpen();
    if (sessionId !== this.sessionId) return Promise.reject(new RepositoryError(`Session recorder is bound to ${this.sessionId}.`, "invalid"));
    return this.waitForWrites().then(() => this.repository.getToolInvocation(sessionId, toolCallId));
  }
  listOpenToolInvocations(sessionId) {
    this.ensureOpen();
    if (sessionId !== this.sessionId) return Promise.reject(new RepositoryError(`Session recorder is bound to ${this.sessionId}.`, "invalid"));
    return this.waitForWrites().then(() => this.repository.listOpenToolInvocations(sessionId));
  }
  async finishRun(result) {
    this.ensureOpen();
    for (const draft of this.activeDrafts.values()) {
      if (draft.runId !== result.runId) continue;
      if (draft.timer !== void 0) clearTimeout(draft.timer);
      draft.timer = void 0;
      draft.terminal = true;
      draft.dirty = true;
      draft.finalStatus = result.status === "completed" ? "completed" : result.status === "cancelled" ? "interrupted" : "failed";
      await this.enqueue(() => this.flushDraft(draft));
    }
    await this.waitForWrites();
  }
  async close() {
    if (this.closed) return;
    for (const draft of this.activeDrafts.values()) {
      if (draft.timer !== void 0) clearTimeout(draft.timer);
      draft.timer = void 0;
      draft.terminal = true;
      draft.dirty = true;
      draft.finalStatus = "interrupted";
      await this.enqueue(() => this.flushDraft(draft));
    }
    await this.waitForWrites();
    this.closed = true;
  }
  scheduleFlush(draft, immediate) {
    if (draft.timer !== void 0) {
      clearTimeout(draft.timer);
      draft.timer = void 0;
    }
    if (immediate) void this.enqueue(() => this.flushDraft(draft));
  }
  async flushDraft(draft) {
    if (!draft.dirty && draft.revision !== null) return;
    const finalStatus = draft.finalStatus;
    const status = finalStatus ?? (draft.terminal ? "completed" : "streaming");
    let entry;
    if (draft.revision === null) {
      entry = await this.repository.appendEntry(this.sessionId, {
        id: draft.entryId,
        type: "assistant_message",
        status,
        runId: draft.runId,
        turnId: draft.turnId,
        payload: cloneMessage(draft.message)
      });
    } else {
      entry = await this.repository.updateEntry(draft.entryId, draft.revision, {
        status,
        payload: cloneMessage(draft.message)
      });
    }
    draft.revision = entry.revision;
    this.assistantEntries.set(draft.turnId, entry.id);
    draft.pendingBytes = 0;
    draft.dirty = false;
    if (status === "completed") this.completedMessages.push(cloneMessage(entry.payload));
    if (draft.terminal) this.activeDrafts.delete(draft.key);
  }
  enqueue(operation) {
    const next = this.writeChain.then(operation, operation);
    this.writeChain = next.catch((error) => {
      this.backgroundError = error;
    });
    return next;
  }
  enqueueResult(operation) {
    const next = this.writeChain.then(operation, operation);
    this.writeChain = next.then(
      () => void 0,
      (error) => {
        this.backgroundError = error;
      }
    );
    return next;
  }
  async enqueueAndCheck(operation) {
    await this.enqueue(operation);
    await this.waitForWrites();
  }
  async waitForWrites() {
    await this.writeChain;
    if (this.backgroundError) throw this.backgroundError;
  }
  ensureOpen() {
    if (this.closed) throw new RepositoryError("Session recorder is closed.", "storage");
  }
}
async function readAllEntries(repository, sessionId) {
  const entries = [];
  let cursor = 0;
  while (true) {
    const batch = await repository.listEntries(sessionId, cursor, 500);
    entries.push(...batch);
    if (batch.length < 500) return entries;
    cursor = batch[batch.length - 1].sessionSeq;
  }
}
async function createSessionRecorder(repository, sessionId) {
  const session = await repository.getSession(sessionId);
  if (!session) throw new RepositoryError(`Session not found: ${sessionId}`, "not_found");
  const entries = await readAllEntries(repository, sessionId);
  for (const entry of entries) {
    if (entry.status !== "streaming") continue;
    await repository.updateEntry(entry.id, entry.revision, { status: "interrupted" });
    entry.status = "interrupted";
    entry.revision += 1;
  }
  return new DefaultSessionRecorder(sessionId, repository, entries);
}
const mainProcessDirectory = fileURLToPath(new URL(".", import.meta.url));
function createWindow() {
  const win = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 840,
    minHeight: 560,
    title: "",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 16, y: 20 },
    show: false,
    webPreferences: {
      preload: join(mainProcessDirectory, "../preload/index.cjs"),
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
    void win.loadFile(join(mainProcessDirectory, "../renderer/index.html"));
  }
  win.once("ready-to-show", () => {
    win.show();
  });
  return win;
}
function registerIpc(runner, providers, outputFiles, inputAttachments, canvasContexts, sessionId, sessionHistory) {
  const discoveryControllers = /* @__PURE__ */ new Map();
  ipcMain.handle(IPC.run, async (event, req) => {
    try {
      const task = req.task.trim();
      const cwd = req.cwd?.trim() || process.cwd();
      const modelOptionId = req.modelOptionId.trim();
      if (!task) return { ok: false, error: "Enter a task." };
      if (!modelOptionId) return { ok: false, error: "Choose a model." };
      const attachments = await inputAttachments.resolve(Array.isArray(req.attachmentIds) ? req.attachmentIds : []);
      const resolved = await providers.resolve(modelOptionId);
      const runId = randomUUID();
      const canvasContextIds = Array.isArray(req.canvasContextIds) ? req.canvasContextIds.filter((id) => typeof id === "string") : [];
      const resolvedCanvasContexts = canvasContexts.takeMany(canvasContextIds);
      const handle = runner.start({ task: composeTaskWithAttachments(task, attachments), cwd, sessionId, runId, runScopedContext: resolvedCanvasContexts, ...resolved }, (payload) => {
        const win = BrowserWindow.fromWebContents(event.sender);
        if (win && !win.isDestroyed()) win.webContents.send(IPC.event, payload);
      });
      return { ok: true, runId: handle.runId };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });
  ipcMain.on(IPC.stop, () => {
    runner.stop();
  });
  ipcMain.handle(IPC.loadSessionPage, async (_event, request) => {
    return sessionHistory.loadPage(request);
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
  ipcMain.handle(IPC.loadCanvasDocument, async () => {
    return canvasContexts.load();
  });
  ipcMain.handle(IPC.saveCanvasDocument, async (_event, document) => {
    return { revision: await canvasContexts.save(document) };
  });
  ipcMain.handle(IPC.prepareCanvasContext, async (_event, input) => {
    return canvasContexts.prepare(input);
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
    const record = outputFiles.resolveForOpen(runId, fileId);
    if (!record) return { ok: false, error: "The output file does not exist or is no longer valid." };
    const validated = await validateOutputForOpen(record);
    if (!validated.ok) return { ok: false, error: validated.error };
    const error = await shell.openPath(validated.path);
    return error ? { ok: false, error } : { ok: true };
  });
}
app.whenReady().then(async () => {
  const sessionRepository = new SqliteSessionRepository(join(app.getPath("userData"), "agent-sessions.sqlite"));
  const sessionScopeKey = "desktop:local";
  const reusableSession = await sessionRepository.getLatestOpenSession(sessionScopeKey);
  const activeSession = reusableSession ?? await sessionRepository.createSession({ scopeKey: sessionScopeKey });
  const recorder = await createSessionRecorder(sessionRepository, activeSession.id);
  const sessionHistory = new SessionHistoryService(activeSession.id, sessionRepository);
  let closing = false;
  const providers = new ProviderStore(
    join(app.getPath("userData"), "provider-profiles.json"),
    {
      available: () => safeStorage.isEncryptionAvailable(),
      encrypt: (secret) => safeStorage.encryptString(secret).toString("base64"),
      decrypt: (payload) => safeStorage.decryptString(Buffer.from(payload, "base64"))
    }
  );
  const outputFiles = new OutputFileRegistry();
  const inputAttachments = new InputAttachmentRegistry();
  const canvasContexts = new CanvasContextRegistry(new CanvasDocumentStore(app.getPath("userData"), activeSession.id));
  const createRecorder = (sessionId) => {
    if (sessionId !== activeSession.id) throw new Error("The current session is not loaded.");
    return recorder;
  };
  const runner = new AgentRunner((runId, cwd, artifacts) => outputFiles.register(runId, cwd, artifacts), createRecorder);
  registerIpc(runner, providers, outputFiles, inputAttachments, canvasContexts, activeSession.id, sessionHistory);
  createWindow();
  app.on("before-quit", (event) => {
    if (closing) return;
    event.preventDefault();
    closing = true;
    runner.stop();
    void (async () => {
      try {
        await runner.waitForIdle();
        await recorder.close();
      } finally {
        sessionRepository.close();
        app.quit();
      }
    })();
  });
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}).catch((error) => {
  dialog.showErrorBox("Session storage initialization failed", error instanceof Error ? error.message : String(error));
  app.quit();
});
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
export {
  ModelAdapterError as M
};
