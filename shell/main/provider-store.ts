import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type {
  DiscoveredModel,
  ModelOption,
  Provider,
  ProviderModelDiscoveryInput,
  ProviderModelState,
  ProviderProfileInput,
  ProviderProfileSummary,
} from "../shared/ipc.js";
import { inferProviderFromBaseURL, type ProviderDiscoveryConnection } from "./provider-model-discovery.js";

const STORE_VERSION = 2;
// 只保留 OpenAI 兼容协议（DeepSeek 等）：历史存量 profile（anthropic/google 等）
// 在加载时不再通过校验，视为废弃数据；重新添加时按 openai 协议处理。
const PROVIDERS = new Set<Provider>(["openai"]);

interface StoredModel {
  modelOptionId: string;
  modelId: string;
  displayName: string;
  available: boolean;
  imported: boolean;
  state: ProviderModelState;
}

interface StoredProfile {
  providerProfileId: string;
  provider: Provider;
  name: string;
  baseURL: string;
  encryptedApiKey: string;
  models: StoredModel[];
}

interface StoreDocument {
  version: number;
  profiles: StoredProfile[];
}

interface LegacyStoredModel {
  modelOptionId: string;
  modelId: string;
  displayName: string;
}

interface LegacyStoredProfile {
  providerProfileId: string;
  provider: Provider;
  displayName: string;
  baseURL?: string;
  encryptedApiKey: string;
  models: LegacyStoredModel[];
}

export interface SecretCodec {
  available(): boolean;
  encrypt(secret: string): string;
  decrypt(payload: string): string;
}

export interface ResolvedModelOption {
  providerProfileId: string;
  modelOptionId: string;
  provider: Provider;
  modelId: string;
  baseURL?: string;
  apiKey: string;
}

export class ProviderStore {
  private profiles: StoredProfile[] = [];
  private loaded = false;
  private loadPromise: Promise<void> | null = null;
  private mutation: Promise<void> = Promise.resolve();

  constructor(
    private readonly filePath: string,
    private readonly codec: SecretCodec,
  ) {}

  async list(): Promise<ProviderProfileSummary[]> {
    await this.ensureLoaded();
    return this.profiles.map((profile) => this.toSummary(profile));
  }

  async save(input: ProviderProfileInput): Promise<ProviderProfileSummary> {
    return this.serialize(async () => {
      await this.ensureLoaded();
      const normalized = normalizeInput(input);
      const existingIndex = normalized.providerProfileId
        ? this.profiles.findIndex((profile) => profile.providerProfileId === normalized.providerProfileId)
        : -1;
      const existing = existingIndex >= 0 ? this.profiles[existingIndex] : undefined;

      if (!existing && !normalized.apiKey) throw new Error("新增提供商必须填写 API Key。");
      const encryptedApiKey = this.resolveEncryptedSecret(normalized.apiKey, existing);
      const previousModels = new Map(existing?.models.map((model) => [model.modelId, model]) ?? []);
      const profile: StoredProfile = {
        providerProfileId: existing?.providerProfileId ?? randomUUID(),
        provider: inferProviderFromBaseURL(normalized.baseURL),
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
            state: available ? "saved" : "unavailable",
          };
        }),
      };

      const nextProfiles = [...this.profiles];
      if (existingIndex >= 0) nextProfiles[existingIndex] = profile;
      else nextProfiles.push(profile);
      await this.persist(nextProfiles);
      this.profiles = nextProfiles;
      return this.toSummary(profile);
    });
  }

  async delete(providerProfileId: string): Promise<void> {
    await this.serialize(async () => {
      await this.ensureLoaded();
      const index = this.profiles.findIndex((profile) => profile.providerProfileId === providerProfileId);
      if (index < 0) throw new Error("提供商不存在或已经删除。");
      const nextProfiles = this.profiles.filter((_, profileIndex) => profileIndex !== index);
      await this.persist(nextProfiles);
      this.profiles = nextProfiles;
    });
  }

  async resolve(modelOptionId: string): Promise<ResolvedModelOption> {
    await this.ensureLoaded();
    for (const profile of this.profiles) {
      const model = profile.models.find((candidate) => (
        candidate.modelOptionId === modelOptionId
        && candidate.imported
        && candidate.available
      ));
      if (!model) continue;
      return {
        providerProfileId: profile.providerProfileId,
        modelOptionId,
        provider: profile.provider,
        modelId: model.modelId,
        baseURL: profile.baseURL,
        apiKey: this.decryptSecret(profile),
      };
    }
    throw new Error("所选模型不存在或不可用，请重新选择。");
  }

  async discoveryConnection(input: ProviderModelDiscoveryInput): Promise<ProviderDiscoveryConnection> {
    await this.ensureLoaded();
    const baseURL = normalizeBaseURL(input.baseURL);
    const existing = input.providerProfileId
      ? this.profiles.find((profile) => profile.providerProfileId === input.providerProfileId)
      : undefined;
    if (input.providerProfileId && !existing) throw new Error("提供商不存在或已经删除。");
    const apiKey = input.apiKey?.trim() || (existing ? this.decryptSecret(existing) : "");
    if (!apiKey) throw new Error("请填写 API Key。");
    return { provider: inferProviderFromBaseURL(baseURL), baseURL, apiKey };
  }

  async refreshConnection(providerProfileId: string): Promise<ProviderDiscoveryConnection> {
    await this.ensureLoaded();
    const profile = this.profiles.find((candidate) => candidate.providerProfileId === providerProfileId);
    if (!profile) throw new Error("提供商不存在或已经删除。");
    return { provider: profile.provider, baseURL: profile.baseURL, apiKey: this.decryptSecret(profile) };
  }

  async applyRefresh(providerProfileId: string, discovered: DiscoveredModel[]): Promise<ProviderProfileSummary> {
    return this.serialize(async () => {
      await this.ensureLoaded();
      const profileIndex = this.profiles.findIndex((profile) => profile.providerProfileId === providerProfileId);
      if (profileIndex < 0) throw new Error("提供商不存在或已经删除。");
      const profile = this.profiles[profileIndex];
      const remote = new Map(discovered.map((model) => [model.id, model]));
      const previous = new Map(profile.models.map((model) => [model.modelId, model]));
      const models: StoredModel[] = discovered.map((model) => {
        const saved = previous.get(model.id);
        if (!saved) {
          return {
            modelOptionId: randomUUID(),
            modelId: model.id,
            displayName: model.displayName,
            available: true,
            imported: false,
            state: "new",
          };
        }
        return {
          ...saved,
          displayName: model.displayName,
          available: true,
          state: saved.imported ? "saved" : "new",
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

  private resolveEncryptedSecret(apiKey: string | undefined, existing: StoredProfile | undefined): string {
    if (!apiKey) {
      if (!existing?.encryptedApiKey) throw new Error("提供商缺少可用凭据。");
      return existing.encryptedApiKey;
    }
    if (!this.codec.available()) throw new Error("系统凭据加密当前不可用，未保存 API Key。");
    return this.codec.encrypt(apiKey);
  }

  private decryptSecret(profile: StoredProfile): string {
    if (!this.codec.available()) throw new Error("系统凭据解密当前不可用。");
    try {
      const apiKey = this.codec.decrypt(profile.encryptedApiKey);
      if (!apiKey) throw new Error("empty secret");
      return apiKey;
    } catch (error) {
      throw new Error(`提供商 ${profile.name} 的凭据无法解密，请重新配置。`, { cause: error });
    }
  }

  private async serialize<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.mutation;
    let release: () => void = () => undefined;
    this.mutation = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    if (!this.loadPromise) this.loadPromise = this.load();
    await this.loadPromise;
  }

  private async load(): Promise<void> {
    let completed = false;
    try {
      const parsed = JSON.parse(await readFile(this.filePath, "utf8")) as { version?: unknown; profiles?: unknown };
      if (parsed.version === STORE_VERSION && Array.isArray(parsed.profiles)) {
        this.profiles = parsed.profiles.filter(isStoredProfile);
      } else if (parsed.version === 1 && Array.isArray(parsed.profiles)) {
        this.profiles = parsed.profiles.filter(isLegacyStoredProfile).map(migrateLegacyProfile);
      }
      completed = true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") throw new Error("无法读取提供商配置。", { cause: error });
      completed = true;
    } finally {
      this.loaded = completed;
      this.loadPromise = null;
    }
  }

  private async persist(profiles: StoredProfile[]): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    const payload: StoreDocument = { version: STORE_VERSION, profiles };
    await writeFile(temporaryPath, `${JSON.stringify(payload, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporaryPath, this.filePath);
  }

  private toSummary(profile: StoredProfile): ProviderProfileSummary {
    const credentialConfigured = Boolean(profile.encryptedApiKey);
    const credentialAvailable = credentialConfigured && this.codec.available();
    return {
      providerProfileId: profile.providerProfileId,
      name: profile.name,
      baseURL: profile.baseURL,
      credentialConfigured,
      models: profile.models.map<ModelOption>((model) => ({
        modelOptionId: model.modelOptionId,
        providerProfileId: profile.providerProfileId,
        providerName: profile.name,
        modelId: model.modelId,
        displayName: model.displayName,
        available: credentialAvailable && model.available,
        imported: model.imported,
        state: model.state,
      })),
    };
  }
}

function normalizeInput(input: ProviderProfileInput): ProviderProfileInput & {
  name: string;
  baseURL: string;
  apiKey?: string;
  models: Array<DiscoveredModel & { available?: boolean }>;
} {
  const name = input.name.trim();
  if (!name) throw new Error("请输入提供商名称。");
  const baseURL = normalizeBaseURL(input.baseURL);
  const models = input.models.map((model) => ({
    id: model.id.trim(),
    displayName: model.displayName.trim() || model.id.trim(),
    available: model.available,
  })).filter((model) => model.id);
  if (models.length === 0) throw new Error("请至少选择一个模型。");
  if (new Set(models.map((model) => model.id)).size !== models.length) {
    throw new Error("同一提供商内不能重复保存模型。");
  }
  return {
    providerProfileId: input.providerProfileId,
    name,
    baseURL,
    apiKey: input.apiKey?.trim() || undefined,
    models,
  };
}

function normalizeBaseURL(value: string): string {
  const input = value.trim();
  if (!input) throw new Error("请填写 API Base URL。");
  let url: URL;
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

function isStoredProfile(value: unknown): value is StoredProfile {
  if (!value || typeof value !== "object") return false;
  const profile = value as Partial<StoredProfile>;
  return typeof profile.providerProfileId === "string"
    && PROVIDERS.has(profile.provider as Provider)
    && typeof profile.name === "string"
    && typeof profile.baseURL === "string"
    && typeof profile.encryptedApiKey === "string"
    && Array.isArray(profile.models)
    && profile.models.every(isStoredModel);
}

function isStoredModel(value: unknown): value is StoredModel {
  if (!value || typeof value !== "object") return false;
  const model = value as Partial<StoredModel>;
  return typeof model.modelOptionId === "string"
    && typeof model.modelId === "string"
    && typeof model.displayName === "string"
    && typeof model.available === "boolean"
    && typeof model.imported === "boolean"
    && (model.state === "saved" || model.state === "new" || model.state === "unavailable");
}

function isLegacyStoredProfile(value: unknown): value is LegacyStoredProfile {
  if (!value || typeof value !== "object") return false;
  const profile = value as Partial<LegacyStoredProfile>;
  return typeof profile.providerProfileId === "string"
    && PROVIDERS.has(profile.provider as Provider)
    && typeof profile.displayName === "string"
    && typeof profile.encryptedApiKey === "string"
    && Array.isArray(profile.models)
    && profile.models.every((model) => (
      model && typeof model === "object"
      && typeof (model as LegacyStoredModel).modelOptionId === "string"
      && typeof (model as LegacyStoredModel).modelId === "string"
      && typeof (model as LegacyStoredModel).displayName === "string"
    ));
}

function migrateLegacyProfile(profile: LegacyStoredProfile): StoredProfile {
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
      state: "saved",
    })),
  };
}

function defaultBaseURL(_provider: Provider): string {
  return "https://api.deepseek.com/v1";
}
