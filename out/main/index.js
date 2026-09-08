import { app, safeStorage, BrowserWindow, ipcMain, dialog, shell } from "electron";
import { resolve, basename, relative, sep, extname, dirname, join, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { realpath, stat, readFile, open, mkdir, writeFile, rename, opendir, lstat, readdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
const IPC = {
  run: "agent:run",
  stop: "agent:stop",
  event: "agent:event",
  listProviderProfiles: "providers:list",
  discoverProviderModels: "providers:discover-models",
  cancelProviderModelDiscovery: "providers:cancel-discovery",
  refreshProviderModels: "providers:refresh-models",
  saveProvider: "providers:save",
  deleteProvider: "providers:delete",
  selectAttachments: "attachments:select",
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
    if (!record) return failure("not_found", "输出文件不存在或已经失效。");
    const verified = await verifyRecord(record);
    if (!verified.ok) return failure("not_found", verified.message);
    const fileStats = verified.stats;
    const updatedAt = fileStats.mtime.toISOString();
    const byteSize = Number(fileStats.size);
    if (IMAGE_MEDIA_TYPES.has(record.descriptor.mediaType)) {
      if (byteSize > MAX_IMAGE_BYTES) return failure("too_large", "图片超过 5 MB，无法内嵌预览。", record.descriptor.mediaType, byteSize);
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
        return failure("read_failed", "图片读取失败。", record.descriptor.mediaType, byteSize);
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
      return failure("read_failed", "文件读取失败。", record.descriptor.mediaType, byteSize);
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
    const canonical = await realpath(record.path);
    if (canonical !== record.path) return { ok: false, error: "输出文件路径已经变化。" };
    const fileStats = await stat(canonical);
    if (!fileStats.isFile()) return { ok: false, error: "输出目标不再是文件。" };
    return { ok: true, path: canonical };
  } catch {
    return { ok: false, error: "输出文件不存在或无法访问。" };
  }
}
function displayPath(cwd, path) {
  const relativePath = relative(resolve(cwd), path);
  if (relativePath && relativePath !== ".." && !relativePath.startsWith(`..${sep}`)) return relativePath;
  return path;
}
async function verifyRecord(record) {
  try {
    const canonical = await realpath(record.path);
    if (canonical !== record.path) return { ok: false, message: "输出文件路径已经变化。" };
    const stats = await stat(canonical);
    if (!stats.isFile()) return { ok: false, message: "输出目标不再是文件。" };
    return { ok: true, stats };
  } catch {
    return { ok: false, message: "输出文件不存在或无法访问。" };
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
      if (!record) throw new Error("附件不存在或已经失效，请重新上传。");
      try {
        const path = await realpath(record.path);
        const fileStats = await stat(path);
        if (path !== record.path || !fileStats.isFile()) throw new Error();
        attachments.push({ ...record.descriptor, path });
      } catch {
        throw new Error(`附件“${record.descriptor.name}”不存在或无法访问，请重新上传。`);
      }
    }
    return attachments;
  }
}
function composeTaskWithAttachments(task, attachments) {
  if (attachments.length === 0) return task;
  const list = attachments.map((attachment) => `- ${attachment.name}: ${JSON.stringify(attachment.path)}`).join("\n");
  return `${task}

用户附加了以下本地文件。仅在与任务相关时使用可用工具读取它们：
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
        lastError = error instanceof ProviderDiscoveryError ? error : new ProviderDiscoveryError("network", "无法连接到服务，请检查网络和 Base URL。", { cause: error });
      }
    }
    if (controller.signal.aborted) {
      throw new ProviderDiscoveryError(
        timedOut ? "timeout" : "cancelled",
        timedOut ? "连接超时，请重试。" : "已取消获取模型。",
        { cause: lastError }
      );
    }
    const normalized = normalizeDiscoveredModels(models);
    if (normalized.length === 0) {
      if (lastError) throw lastError;
      throw new ProviderDiscoveryError("empty", "连接成功，但没有返回模型。");
    }
    return normalized;
  } catch (error) {
    if (error instanceof ProviderDiscoveryError) throw error;
    throw new ProviderDiscoveryError("network", "无法连接到服务，请检查网络和 Base URL。", { cause: error });
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
    if (visited.has(url)) throw new ProviderDiscoveryError("invalid_response", "模型列表分页游标无效。");
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
  if (kind === "authentication") return "API Key 无效或没有访问权限。";
  if (kind === "unsupported") return "该服务不支持获取模型列表。";
  return `模型列表请求失败，状态码 ${status}。`;
}
function parseModelPage(payload) {
  if (!payload || typeof payload !== "object") {
    throw new ProviderDiscoveryError("invalid_response", "模型列表响应格式无效。");
  }
  const list = payload.data;
  if (!Array.isArray(list)) {
    throw new ProviderDiscoveryError("invalid_response", "模型列表响应格式无效。");
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
    if (next.origin !== origin) throw new ProviderDiscoveryError("invalid_response", "模型列表分页地址无效。");
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
    throw new ProviderDiscoveryError("invalid_response", "模型列表响应格式无效。", { cause: error });
  }
}
function firstString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}
const STORE_VERSION = 2;
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
    return this.profiles.map((profile) => this.toSummary(profile));
  }
  async save(input) {
    return this.serialize(async () => {
      await this.ensureLoaded();
      const normalized = normalizeInput(input);
      const existingIndex = normalized.providerProfileId ? this.profiles.findIndex((profile2) => profile2.providerProfileId === normalized.providerProfileId) : -1;
      const existing = existingIndex >= 0 ? this.profiles[existingIndex] : void 0;
      if (!existing && !normalized.apiKey) throw new Error("新增提供商必须填写 API Key。");
      const encryptedApiKey = this.resolveEncryptedSecret(normalized.apiKey, existing);
      const previousModels = new Map(existing?.models.map((model) => [model.modelId, model]) ?? []);
      const profile = {
        providerProfileId: existing?.providerProfileId ?? randomUUID(),
        provider: inferProviderFromBaseURL(),
        name: normalized.name,
        baseURL: normalized.baseURL,
        encryptedApiKey,
        models: normalized.models.map((model) => {
          const previous = previousModels.get(model.id);
          const available = model.available ?? previous?.available ?? true;
          return {
            modelOptionId: previous?.modelOptionId ?? randomUUID(),
            modelId: model.id,
            displayName: model.displayName,
            available,
            imported: true,
            state: available ? "saved" : "unavailable"
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
      if (index < 0) throw new Error("提供商不存在或已经删除。");
      const nextProfiles = this.profiles.filter((_, profileIndex) => profileIndex !== index);
      await this.persist(nextProfiles);
      this.profiles = nextProfiles;
    });
  }
  async resolve(modelOptionId) {
    await this.ensureLoaded();
    for (const profile of this.profiles) {
      const model = profile.models.find((candidate) => candidate.modelOptionId === modelOptionId && candidate.imported && candidate.available);
      if (!model) continue;
      return {
        providerProfileId: profile.providerProfileId,
        modelOptionId,
        provider: profile.provider,
        modelId: model.modelId,
        baseURL: profile.baseURL,
        apiKey: this.decryptSecret(profile)
      };
    }
    throw new Error("所选模型不存在或不可用，请重新选择。");
  }
  async discoveryConnection(input) {
    await this.ensureLoaded();
    const baseURL = normalizeBaseURL(input.baseURL);
    const existing = input.providerProfileId ? this.profiles.find((profile) => profile.providerProfileId === input.providerProfileId) : void 0;
    if (input.providerProfileId && !existing) throw new Error("提供商不存在或已经删除。");
    const apiKey = input.apiKey?.trim() || (existing ? this.decryptSecret(existing) : "");
    if (!apiKey) throw new Error("请填写 API Key。");
    return { provider: inferProviderFromBaseURL(), baseURL, apiKey };
  }
  async refreshConnection(providerProfileId) {
    await this.ensureLoaded();
    const profile = this.profiles.find((candidate) => candidate.providerProfileId === providerProfileId);
    if (!profile) throw new Error("提供商不存在或已经删除。");
    return { provider: profile.provider, baseURL: profile.baseURL, apiKey: this.decryptSecret(profile) };
  }
  async applyRefresh(providerProfileId, discovered) {
    return this.serialize(async () => {
      await this.ensureLoaded();
      const profileIndex = this.profiles.findIndex((profile2) => profile2.providerProfileId === providerProfileId);
      if (profileIndex < 0) throw new Error("提供商不存在或已经删除。");
      const profile = this.profiles[profileIndex];
      const remote = new Map(discovered.map((model) => [model.id, model]));
      const previous = new Map(profile.models.map((model) => [model.modelId, model]));
      const models = discovered.map((model) => {
        const saved = previous.get(model.id);
        if (!saved) {
          return {
            modelOptionId: randomUUID(),
            modelId: model.id,
            displayName: model.displayName,
            available: true,
            imported: false,
            state: "new"
          };
        }
        return {
          ...saved,
          displayName: model.displayName,
          available: true,
          state: saved.imported ? "saved" : "new"
        };
      });
      for (const model of profile.models) {
        if (remote.has(model.modelId) || !model.imported) continue;
        models.push({ ...model, available: false, state: "unavailable" });
      }
      const refreshed = { ...profile, models };
      const nextProfiles = [...this.profiles];
      nextProfiles[profileIndex] = refreshed;
      await this.persist(nextProfiles);
      this.profiles = nextProfiles;
      return this.toSummary(refreshed);
    });
  }
  resolveEncryptedSecret(apiKey, existing) {
    if (!apiKey) {
      if (!existing?.encryptedApiKey) throw new Error("提供商缺少可用凭据。");
      return existing.encryptedApiKey;
    }
    if (!this.codec.available()) throw new Error("系统凭据加密当前不可用，未保存 API Key。");
    return this.codec.encrypt(apiKey);
  }
  decryptSecret(profile) {
    if (!this.codec.available()) throw new Error("系统凭据解密当前不可用。");
    try {
      const apiKey = this.codec.decrypt(profile.encryptedApiKey);
      if (!apiKey) throw new Error("empty secret");
      return apiKey;
    } catch (error) {
      throw new Error(`提供商 ${profile.name} 的凭据无法解密，请重新配置。`, { cause: error });
    }
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
      if (parsed.version === STORE_VERSION && Array.isArray(parsed.profiles)) {
        this.profiles = parsed.profiles.filter(isStoredProfile);
      } else if (parsed.version === 1 && Array.isArray(parsed.profiles)) {
        this.profiles = parsed.profiles.filter(isLegacyStoredProfile).map(migrateLegacyProfile);
      }
      completed = true;
    } catch (error) {
      const code = error.code;
      if (code !== "ENOENT") throw new Error("无法读取提供商配置。", { cause: error });
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
  toSummary(profile) {
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
}
function normalizeInput(input) {
  const name = input.name.trim();
  if (!name) throw new Error("请输入提供商名称。");
  const baseURL = normalizeBaseURL(input.baseURL);
  const models = input.models.map((model) => ({
    id: model.id.trim(),
    displayName: model.displayName.trim() || model.id.trim(),
    available: model.available
  })).filter((model) => model.id);
  if (models.length === 0) throw new Error("请至少选择一个模型。");
  if (new Set(models.map((model) => model.id)).size !== models.length) {
    throw new Error("同一提供商内不能重复保存模型。");
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
  if (!input) throw new Error("请填写 API Base URL。");
  let url;
  try {
    url = new URL(input);
  } catch {
    throw new Error("API Base URL 不是有效 URL。");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("API Base URL 只支持 HTTP 或 HTTPS。");
  }
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}
function isStoredProfile(value) {
  if (!value || typeof value !== "object") return false;
  const profile = value;
  return typeof profile.providerProfileId === "string" && PROVIDERS.has(profile.provider) && typeof profile.name === "string" && typeof profile.baseURL === "string" && typeof profile.encryptedApiKey === "string" && Array.isArray(profile.models) && profile.models.every(isStoredModel);
}
function isStoredModel(value) {
  if (!value || typeof value !== "object") return false;
  const model = value;
  return typeof model.modelOptionId === "string" && typeof model.modelId === "string" && typeof model.displayName === "string" && typeof model.available === "boolean" && typeof model.imported === "boolean" && (model.state === "saved" || model.state === "new" || model.state === "unavailable");
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
async function* response(config, messages, system, tools, signal) {
  switch (config.provider) {
    case "openai": {
      const { streamOpenAI } = await import("./openai-wf36DTXp.js");
      yield* streamOpenAI(messages, tools, { model: config.model, ...config.openai }, system, signal);
      return;
    }
  }
}
const DEFAULT_SYSTEM_PROMPT = "You are a coding agent. Use the available tools when needed, then provide a concise final answer.";
async function collectTurn(modelConfig, messages, system, tools, ctx, events, signal, responseImpl) {
  const aggregated = { content: "", toolCalls: [], stopReason: "stop" };
  for await (const event of responseImpl(modelConfig, messages, system, tools, signal)) {
    switch (event.type) {
      case "reasoning_delta":
        aggregated.reasoning = (aggregated.reasoning ?? "") + event.delta;
        events.onReasoningDelta?.(event.delta, ctx);
        break;
      case "text_delta":
        aggregated.content += event.delta;
        events.onAssistantDelta?.(event.delta, ctx);
        break;
      case "completed":
        aggregated.content = event.content;
        aggregated.reasoning = event.reasoning;
        aggregated.toolCalls = event.toolCalls;
        aggregated.stopReason = event.stopReason;
        aggregated.rawStopReason = event.rawStopReason;
        break;
    }
  }
  return aggregated;
}
async function run(task, modelConfig, config, events = {}) {
  const startedAt = (/* @__PURE__ */ new Date()).toISOString();
  events.onRunStart?.({ runId: config.runId, startedAt });
  const messages = [...config.history ?? [], { role: "user", content: task }];
  const userMessage = messages[messages.length - 1];
  events.onMessageFinalized?.(userMessage);
  const tools = [...config.tools.values()].map((tool) => tool.definition);
  let turnOrdinal = 0;
  const finish = (status, error) => {
    const result = { runId: config.runId, status, error, turnCount: turnOrdinal };
    events.onRunCompleted?.(result);
    return result;
  };
  while (true) {
    if (config.signal?.aborted) return finish("cancelled");
    const ctx = { runId: config.runId, turnId: randomUUID(), turnOrdinal: ++turnOrdinal };
    events.onTurnStart?.(ctx);
    let result;
    try {
      result = await collectTurn(modelConfig, messages, config.systemPrompt || DEFAULT_SYSTEM_PROMPT, tools, ctx, events, config.signal, config.responseImpl ?? response);
    } catch (error) {
      if (config.signal?.aborted) return finish("cancelled");
      return finish("failed", { kind: "runtime", message: error instanceof Error ? error.message : String(error) });
    }
    events.onAssistantCompleted?.(result, ctx);
    const assistantMessage = { role: "assistant", content: result.content, reasoning: result.reasoning, toolCalls: result.toolCalls };
    messages.push(assistantMessage);
    events.onMessageFinalized?.(assistantMessage);
    if (config.signal?.aborted || result.stopReason === "aborted") return finish("cancelled");
    if (result.stopReason === "error" || result.error) {
      return finish("failed", result.error ?? { kind: "provider", message: "模型请求失败。" });
    }
    if (result.toolCalls.length === 0) {
      events.onTurnCompleted?.(ctx);
      return finish("completed");
    }
    for (const call of result.toolCalls) {
      if (config.signal?.aborted) return finish("cancelled");
      events.onToolStart?.(call, ctx);
      const result2 = await executeTool(call, config.tools, config.cwd, config.signal);
      const toolMessage = { role: "tool", content: formatToolResult(result2), toolCallId: call.id, toolName: call.name, isError: !result2.ok, media: result2.media };
      messages.push(toolMessage);
      events.onMessageFinalized?.(toolMessage);
      events.onToolCompleted?.(call, result2, ctx);
    }
    events.onTurnCompleted?.(ctx);
  }
}
async function executeTool(call, tools, cwd, signal) {
  if (!call.inputComplete) return invalidResult("工具参数被模型响应截断，未执行。请重新生成完整的工具调用。", "truncated_arguments");
  const tool = tools.get(call.name);
  if (!tool) return invalidResult(`未知工具：${call.name}`, "unknown_tool");
  return tool.execute(call.input, { cwd, signal });
}
function invalidResult(output, error) {
  return { ok: false, output, returncode: -1, truncated: false, error };
}
function formatToolResult(result) {
  const note = result.truncated && result.fullOutputPath ? `
完整输出：${result.fullOutputPath}` : "";
  return `<returncode>${result.returncode}</returncode>
<output>
${result.output}
</output>${note}`;
}
class SessionStore {
  messages = [];
  append(message) {
    this.messages.push(message);
  }
  snapshot() {
    return this.messages.slice();
  }
  clear() {
    this.messages = [];
  }
}
const sessionStore = new SessionStore();
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
      reject(new Error("命令已取消。"));
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

... 省略前 ${raw.length - TRUNCATE_KEEP} 字符，完整输出已保存到内部临时文件 ...`,
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
    async execute(input, context) {
      if (typeof input.command !== "string" || input.command.trim() === "") {
        return { ok: false, output: "工具参数 command 必须是非空字符串。", returncode: -1, truncated: false, error: "invalid_arguments" };
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
    async execute(input, context) {
      if (typeof input.path !== "string" || input.path.trim() === "") {
        return { ok: false, output: "工具参数 path 必须是非空字符串。", returncode: -1, truncated: false, error: "invalid_arguments" };
      }
      const start = typeof input.start === "number" && Number.isInteger(input.start) && input.start >= 1 ? input.start : 1;
      let maxLines = typeof input.maxLines === "number" && Number.isInteger(input.maxLines) ? input.maxLines : DEFAULT_MAX_LINES;
      maxLines = Math.min(Math.max(maxLines, 1), MAX_LINES);
      const target = isAbsolute(input.path) ? input.path : resolve(context.cwd, input.path);
      let stats;
      try {
        stats = await stat(target);
      } catch {
        return { ok: false, output: `文件不存在：${input.path}`, returncode: -1, truncated: false, error: "not_found" };
      }
      if (stats.isDirectory()) {
        return { ok: false, output: `目标是目录，Read 读取文件：${input.path}`, returncode: -1, truncated: false, error: "target_is_directory" };
      }
      const ext = extname(target).toLowerCase();
      let buffer;
      try {
        buffer = await readFile(target);
      } catch (error) {
        return { ok: false, output: `读取失败：${error instanceof Error ? error.message : String(error)}`, returncode: -1, truncated: false, error: "read_failed" };
      }
      if (IMAGE_EXTENSIONS.has(ext)) {
        const dataUrl = `data:${mimeForExtension(ext)};base64,${buffer.toString("base64")}`;
        return {
          ok: true,
          output: `图片已作为视觉内容返回：${input.path}（${stats.size} 字节）`,
          returncode: 0,
          truncated: false,
          media: { mediaType: mimeForExtension(ext), dataUrl }
        };
      }
      if (buffer.includes(0)) {
        return { ok: false, output: `文件不是文本或模型支持的图片格式：${input.path}`, returncode: -1, truncated: false, error: "binary_file" };
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
        const display = line.length > MAX_LINE_DISPLAY$1 ? `${line.slice(0, MAX_LINE_DISPLAY$1)} …(该行过长已截断)` : line;
        return `${from + i}: ${display}`;
      });
      const rangeNote = linesTruncated ? `已读取 ${from}-${from + page.length - 1} 行，共 ${lines.length} 行；继续读取请用 start=${nextStart}` : `共 ${lines.length} 行`;
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
    async execute(input, context) {
      if (typeof input.path !== "string" || input.path.trim() === "") {
        return { ok: false, output: "工具参数 path 必须是非空字符串。", returncode: -1, truncated: false, error: "invalid_arguments" };
      }
      if (typeof input.content !== "string") {
        return { ok: false, output: "工具参数 content 必须是非空字符串。", returncode: -1, truncated: false, error: "invalid_arguments" };
      }
      const target = isAbsolute(input.path) ? input.path : resolve(context.cwd, input.path);
      let exists = false;
      try {
        const stats = await stat(target);
        if (stats.isDirectory()) {
          return { ok: false, output: `目标是目录，Write 写入文件：${input.path}`, returncode: -1, truncated: false, error: "target_is_directory" };
        }
        exists = true;
      } catch {
        exists = false;
      }
      try {
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, input.content, "utf8");
      } catch (error) {
        return { ok: false, output: `写入失败：${error instanceof Error ? error.message : String(error)}`, returncode: -1, truncated: false, error: "write_failed" };
      }
      const bytes = Buffer.byteLength(input.content, "utf8");
      const rel = relative(context.cwd, target) || target;
      const operation = exists ? "updated" : "created";
      return {
        ok: true,
        output: `已写入 ${rel}（${bytes} 字节，${operation === "created" ? "新建" : "覆盖"}）`,
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
    async execute(input, context) {
      if (typeof input.path !== "string" || input.path.trim() === "") {
        return { ok: false, output: "工具参数 path 必须是非空字符串。", returncode: -1, truncated: false, error: "invalid_arguments" };
      }
      if (!Array.isArray(input.edits) || input.edits.length === 0) {
        return { ok: false, output: "工具参数 edits 必须是非空数组。", returncode: -1, truncated: false, error: "invalid_arguments" };
      }
      const edits = [];
      for (const [i, item] of input.edits.entries()) {
        const oldText = item.oldText;
        const newText = item.newText;
        if (typeof oldText !== "string" || oldText.length === 0) {
          return { ok: false, output: `第 ${i + 1} 项替换的 oldText 必须是非空字符串。`, returncode: -1, truncated: false, error: "invalid_arguments" };
        }
        if (typeof newText !== "string") {
          return { ok: false, output: `第 ${i + 1} 项替换的 newText 必须是字符串。`, returncode: -1, truncated: false, error: "invalid_arguments" };
        }
        edits.push({ oldText, newText });
      }
      const target = isAbsolute(input.path) ? input.path : resolve(context.cwd, input.path);
      let stats;
      try {
        stats = await stat(target);
      } catch {
        return { ok: false, output: `文件不存在：${input.path}`, returncode: -1, truncated: false, error: "not_found" };
      }
      if (stats.isDirectory()) {
        return { ok: false, output: `目标是目录，Edit 修改文件：${input.path}`, returncode: -1, truncated: false, error: "target_is_directory" };
      }
      let original;
      try {
        const buffer = await readFile(target);
        if (buffer.includes(0)) {
          return { ok: false, output: `文件不是可编辑文本（包含二进制内容）：${input.path}`, returncode: -1, truncated: false, error: "binary_file" };
        }
        original = buffer.toString("utf8");
      } catch (error) {
        return { ok: false, output: `读取失败：${error instanceof Error ? error.message : String(error)}`, returncode: -1, truncated: false, error: "read_failed" };
      }
      const matches = [];
      for (const [order, edit] of edits.entries()) {
        const positions = [];
        for (let at = original.indexOf(edit.oldText); at !== -1; at = original.indexOf(edit.oldText, at + 1)) {
          positions.push(at);
        }
        if (positions.length === 0) {
          return { ok: false, output: `第 ${order + 1} 项替换的 oldText 未在文件中找到：${JSON.stringify(edit.oldText.slice(0, 200))}`, returncode: -1, truncated: false, error: "text_not_found" };
        }
        if (positions.length > 1) {
          return { ok: false, output: `第 ${order + 1} 项替换的 oldText 匹配到 ${positions.length} 处，需要唯一匹配：${JSON.stringify(edit.oldText.slice(0, 200))}`, returncode: -1, truncated: false, error: "text_not_unique" };
        }
        matches.push({ index: positions[0], length: edit.oldText.length, edit, order });
      }
      matches.sort((a, b) => a.index - b.index);
      for (let i = 1; i < matches.length; i += 1) {
        const prev = matches[i - 1];
        const curr = matches[i];
        if (curr.index < prev.index + prev.length) {
          return { ok: false, output: `替换片段相互重叠：第 ${prev.order + 1} 项与第 ${curr.order + 1} 项`, returncode: -1, truncated: false, error: "edits_overlap" };
        }
      }
      let updated = original;
      for (const match of [...matches].sort((a, b) => b.index - a.index)) {
        updated = updated.slice(0, match.index) + match.edit.newText + updated.slice(match.index + match.length);
      }
      try {
        await writeFile(target, updated, "utf8");
      } catch (error) {
        return { ok: false, output: `写入失败：${error instanceof Error ? error.message : String(error)}`, returncode: -1, truncated: false, error: "write_failed" };
      }
      const firstLine = (original.slice(0, matches[0].index).match(/\n/g) ?? []).length + 1;
      const rel = relative(context.cwd, target) || target;
      const lines = matches.map((m) => `  #${m.order + 1} 第${(original.slice(0, m.index).match(/\n/g) ?? []).length + 1}行 ${JSON.stringify(m.edit.oldText.slice(0, 200))} → ${JSON.stringify(m.edit.newText.slice(0, 200))}`).join("\n");
      return {
        ok: true,
        output: `<file>${rel}</file>
修改数量: ${matches.length}
第一处变更: 第 ${firstLine} 行
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
    { definition: LIST_DIR_TOOL, execute: listDir },
    { definition: FIND_FILES_TOOL, execute: findFiles },
    { definition: SEARCH_CONTENT_TOOL, execute: searchContent }
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
    return { error: fail(`路径不存在：${inputPath ?? target}`, "not_found") };
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
    return fail("工具参数 path 必须是字符串。", "invalid_arguments");
  }
  let limit = typeof input.limit === "number" && Number.isInteger(input.limit) ? input.limit : LIST_DEFAULT_LIMIT;
  limit = Math.min(Math.max(limit, 1), LIST_MAX_LIMIT);
  const target = toAbs(input.path, context.cwd);
  const { stats, error } = await statOrError(target, input.path);
  if (error) return error;
  if (!stats?.isDirectory()) {
    return fail(`目标不是目录：${input.path ?? target}`, "not_a_directory");
  }
  let entries;
  try {
    entries = await readdir(target, { withFileTypes: true });
  } catch (err) {
    return fail(`读取目录失败：${err instanceof Error ? err.message : String(err)}`, "read_failed");
  }
  const sorted = entries.sort((a, b) => a.name.localeCompare(b.name));
  const page = sorted.slice(0, limit);
  const rel = relative(context.cwd, target);
  const label = rel === "" ? "." : rel;
  const rows = page.map((e) => `${e.isDirectory() ? "dir " : "file "}${e.name}${e.isDirectory() ? "/" : ""}`);
  const truncNote = sorted.length > page.length ? `
已列出前 ${page.length} 项（共 ${sorted.length} 项），未继续列出。` : "";
  return {
    ok: true,
    output: `<directory>${label}</directory>
${rows.join("\n") || "（空目录）"}${truncNote}`,
    returncode: 0,
    truncated: sorted.length > page.length
  };
}
async function findFiles(input, context) {
  if (typeof input.pattern !== "string" || input.pattern.trim() === "") {
    return fail("工具参数 pattern 必须是非空字符串。", "invalid_arguments");
  }
  if (input.path !== void 0 && typeof input.path !== "string") {
    return fail("工具参数 path 必须是字符串。", "invalid_arguments");
  }
  let limit = typeof input.limit === "number" && Number.isInteger(input.limit) ? input.limit : DEFAULT_LIMIT;
  limit = Math.min(Math.max(limit, 1), 1e3);
  const needle = input.pattern.toLowerCase();
  const target = toAbs(input.path, context.cwd);
  const { stats, error } = await statOrError(target, input.path);
  if (error) return error;
  if (!stats?.isDirectory()) {
    return fail(`目标不是目录：${input.path ?? target}`, "not_a_directory");
  }
  const matches = [];
  for await (const file of walkFiles(target, context.signal)) {
    if (matches.length >= limit) {
      return {
        ok: true,
        output: `<search_root>${relative(context.cwd, target) || "."}</search_root>
${matches.join("\n")}
已找到 ${limit} 项，达到结果上限，可能未遍历全部文件。`,
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
${matches.join("\n") || "（没有匹配的文件）"}`,
    returncode: 0,
    truncated: false
  };
}
async function searchContent(input, context) {
  if (typeof input.text !== "string" || input.text === "") {
    return fail("工具参数 text 必须是非空字符串。", "invalid_arguments");
  }
  if (input.path !== void 0 && typeof input.path !== "string") {
    return fail("工具参数 path 必须是字符串。", "invalid_arguments");
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
    return fail(`目标不是目录：${input.path ?? target}`, "not_a_directory");
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
  if (reachedLimit) suffix.push(`达到匹配上限 ${limit} 条，可能未遍历全部文件。`);
  return {
    ok: true,
    output: `<search_root>${relative(context.cwd, target) || "."}</search_root>
${lines.join("\n") || "（没有匹配的内容）"}${suffix.length ? `
${suffix.join("\n")}` : ""}`,
    returncode: 0,
    truncated: reachedLimit || reachedScanCap
  };
}
function truncateLine(line) {
  return line.length > MAX_LINE_DISPLAY ? `${line.slice(0, MAX_LINE_DISPLAY)} …(该行已截断)` : line;
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
      throw new Error(`工具名重复注册：${tool.definition.name}`);
    }
    registry.set(tool.definition.name, tool);
  }
  return registry;
}
const SYSTEM_PROMPT = "You are a coding agent. Use the available tools when needed, then provide a concise final answer.";
class AgentRunner {
  constructor(registerArtifacts) {
    this.registerArtifacts = registerArtifacts;
  }
  registerArtifacts;
  controller = new AbortController();
  active = false;
  get isActive() {
    return this.active;
  }
  start(req, emit) {
    if (this.active) throw new Error("已有运行正在进行，请先停止当前任务。");
    this.active = true;
    this.controller = new AbortController();
    const runId = randomUUID();
    const emitOnce = /* @__PURE__ */ (() => {
      let completed = false;
      return (event) => {
        if (event.type === "runCompleted") {
          if (completed) return;
          completed = true;
          this.active = false;
        }
        emit(event);
      };
    })();
    const events = {
      onRunStart: (ctx) => emitOnce({ type: "runStarted", ...ctx }),
      onMessageFinalized: (message) => sessionStore.append(message),
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
      onTurnCompleted: (ctx) => emitOnce({ type: "turnCompleted", ...ctx }),
      onRunCompleted: (result) => emitOnce({ type: "runCompleted", ...result })
    };
    const modelConfig = {
      provider: "openai",
      model: req.modelId,
      openai: { baseURL: req.baseURL, apiKey: req.apiKey }
    };
    setImmediate(() => {
      void run(req.task, modelConfig, {
        runId,
        systemPrompt: SYSTEM_PROMPT,
        cwd: req.cwd,
        tools: createToolRegistry(createLocalBashOps()),
        signal: this.controller.signal,
        history: sessionStore.snapshot()
      }, events).catch((error) => {
        this.active = false;
        emitOnce({ type: "runCompleted", runId, status: "failed", turnCount: 0, error: { kind: "runtime", message: error instanceof Error ? error.message : String(error) } });
      });
    });
    return { runId, stop: () => this.controller.abort() };
  }
  stop() {
    if (this.active) this.controller.abort();
  }
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
const mainProcessDirectory = fileURLToPath(new URL(".", import.meta.url));
function createWindow() {
  const win = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 840,
    minHeight: 560,
    title: "",
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
function registerIpc(runner, providers, outputFiles, inputAttachments) {
  const discoveryControllers = /* @__PURE__ */ new Map();
  ipcMain.handle(IPC.run, async (event, req) => {
    try {
      const task = req.task.trim();
      const cwd = req.cwd?.trim() || process.cwd();
      const modelOptionId = req.modelOptionId.trim();
      if (!task) return { ok: false, error: "请输入任务。" };
      if (!modelOptionId) return { ok: false, error: "请选择模型。" };
      const attachments = await inputAttachments.resolve(Array.isArray(req.attachmentIds) ? req.attachmentIds : []);
      const resolved = await providers.resolve(modelOptionId);
      const handle = runner.start({ task: composeTaskWithAttachments(task, attachments), cwd, ...resolved }, (payload) => {
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
  ipcMain.handle(IPC.listProviderProfiles, async () => {
    return providers.list();
  });
  ipcMain.handle(IPC.discoverProviderModels, async (event, input) => {
    if (!input || typeof input.requestId !== "string" || !input.requestId) {
      return { ok: false, error: "invalid_response", message: "模型发现请求缺少有效身份。" };
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
    if (runner.isActive) return { ok: false, error: "unsupported", message: "运行期间不能刷新提供商。" };
    if (typeof providerProfileId !== "string" || !providerProfileId) {
      return { ok: false, error: "invalid_response", message: "缺少提供商身份。" };
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
    if (runner.isActive) return { ok: false, error: "运行期间不能修改提供商。" };
    try {
      return { ok: true, profile: await providers.save(input) };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });
  ipcMain.handle(IPC.deleteProvider, async (_event, providerProfileId) => {
    if (runner.isActive) return { ok: false, error: "运行期间不能删除提供商。" };
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
  ipcMain.handle(IPC.previewOutputFile, async (_event, runId, fileId) => {
    if (typeof runId !== "string" || typeof fileId !== "string" || !runId || !fileId) {
      return { ok: false, error: "invalid_request", message: "缺少输出文件身份。" };
    }
    return outputFiles.preview(runId, fileId);
  });
  ipcMain.handle(IPC.openOutputFile, async (_event, runId, fileId) => {
    if (typeof runId !== "string" || typeof fileId !== "string" || !runId || !fileId) {
      return { ok: false, error: "缺少输出文件身份。" };
    }
    const record = outputFiles.resolveForOpen(runId, fileId);
    if (!record) return { ok: false, error: "输出文件不存在或已经失效。" };
    const validated = await validateOutputForOpen(record);
    if (!validated.ok) return { ok: false, error: validated.error };
    const error = await shell.openPath(validated.path);
    return error ? { ok: false, error } : { ok: true };
  });
}
app.whenReady().then(() => {
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
  const runner = new AgentRunner((runId, cwd, artifacts) => outputFiles.register(runId, cwd, artifacts));
  registerIpc(runner, providers, outputFiles, inputAttachments);
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
