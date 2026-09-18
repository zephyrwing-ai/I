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

      if (!existing && !normalized.apiKey) throw new Error("A new provider requires an API Key.");
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
          return {
            modelOptionId: previous?.modelOptionId ?? randomUUID(),
            modelId: model.id,
            displayName: model.displayName,
            available: true,
            imported: true,
            state: "saved",
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
      if (index < 0) throw new Error("The provider does not exist or has already been deleted.");
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
    throw new Error("The selected model does not exist or is unavailable. Choose another model.");
  }

  async discoveryConnection(input: ProviderModelDiscoveryInput): Promise<ProviderDiscoveryConnection> {
    await this.ensureLoaded();
    const baseURL = normalizeBaseURL(input.baseURL);
    const existing = input.providerProfileId
      ? this.profiles.find((profile) => profile.providerProfileId === input.providerProfileId)
      : undefined;
    if (input.providerProfileId && !existing) throw new Error("The provider does not exist or has already been deleted.");
    const apiKey = input.apiKey?.trim() || (existing ? this.decryptSecret(existing) : "");
    if (!apiKey) throw new Error("Enter an API Key.");
    return { provider: inferProviderFromBaseURL(baseURL), baseURL, apiKey };
  }

  async refreshConnection(providerProfileId: string): Promise<ProviderDiscoveryConnection> {
    await this.ensureLoaded();
    const profile = this.profiles.find((candidate) => candidate.providerProfileId === providerProfileId);
    if (!profile) throw new Error("The provider does not exist or has already been deleted.");
    return { provider: profile.provider, baseURL: profile.baseURL, apiKey: this.decryptSecret(profile) };
  }

  async applyRefresh(providerProfileId: string, discovered: DiscoveredModel[]): Promise<ProviderProfileSummary> {
    return this.serialize(async () => {
      await this.ensureLoaded();
      const profileIndex = this.profiles.findIndex((profile) => profile.providerProfileId === providerProfileId);
      if (profileIndex < 0) throw new Error("The provider does not exist or has already been deleted.");
      const profile = this.profiles[profileIndex];
      const previous = new Map(profile.models.map((model) => [model.modelId, model]));
      const models: StoredModel[] = discovered.map((model) => {
        const saved = previous.get(model.id);
        return {
          modelOptionId: saved?.modelOptionId ?? randomUUID(),
          modelId: model.id,
          displayName: model.displayName,
          available: true,
          imported: true,
          state: "saved",
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

  private resolveEncryptedSecret(apiKey: string | undefined, existing: StoredProfile | undefined): string {
    if (!apiKey) {
      if (!existing?.encryptedApiKey) throw new Error("The provider has no usable credentials.");
      return existing.encryptedApiKey;
    }
    if (!this.codec.available()) throw new Error("System credential encryption is currently unavailable. The API Key was not saved.");
    return this.codec.encrypt(apiKey);
  }

  private decryptSecret(profile: StoredProfile): string {
    if (!this.codec.available()) throw new Error("System credential decryption is currently unavailable.");
    try {
      const apiKey = this.codec.decrypt(profile.encryptedApiKey);
      if (!apiKey) throw new Error("empty secret");
      return apiKey;
    } catch (error) {
      throw new Error(`The credentials for provider ${profile.name} could not be decrypted. Configure it again.`, { cause: error });
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
        this.profiles = parsed.profiles.filter(isStoredProfile).map(normalizeStoredProfile);
      } else if (parsed.version === 1 && Array.isArray(parsed.profiles)) {
        this.profiles = parsed.profiles.filter(isLegacyStoredProfile).map(migrateLegacyProfile).map(normalizeStoredProfile);
      }
      completed = true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") throw new Error("Unable to read the provider configuration.", { cause: error });
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
  models: DiscoveredModel[];
} {
  const name = input.name.trim();
  if (!name) throw new Error("Enter a provider name.");
  const baseURL = normalizeBaseURL(input.baseURL);
  const models = input.models.map((model) => ({
    id: model.id.trim(),
    displayName: model.displayName.trim() || model.id.trim(),
  })).filter((model) => model.id);
  if (models.length === 0) throw new Error("Select at least one model.");
  if (new Set(models.map((model) => model.id)).size !== models.length) {
    throw new Error("A provider cannot save duplicate models.");
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
  if (!input) throw new Error("Enter an API Base URL.");
  let url: URL;
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

function normalizeStoredProfile(profile: StoredProfile): StoredProfile {
  const models: StoredModel[] = profile.models
    .filter((model) => model.available && model.state !== "unavailable")
    .map((model) => ({ ...model, imported: true, state: "saved" }));
  return { ...profile, models };
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
