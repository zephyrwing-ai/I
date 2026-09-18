import type {
  DiscoveredModel,
  Provider,
  ProviderModelDiscoveryErrorKind,
  ProviderModelDiscoveryResult,
} from "../shared/ipc.js";

/**
 * 模型列表探测：只走 OpenAI 兼容方言（DeepSeek 等）。
 * 列表格式 `data[]`(id/name/display_name)，分页 `has_more`+`last_id`→`after` 或 `next` 链接；Bearer 鉴权。
 */
export type ModelDialect = "openai";
export type ModelAuthKind = "bearer";

/** 单个待测端点：URL + 该端点该用的方言/鉴权。由 buildModelEndpointProbes 生成。 */
export interface ModelEndpointProbe {
  url: string;
  dialect: ModelDialect;
  auth: ModelAuthKind;
}

export interface ProviderDiscoveryConnection {
  provider: Provider;
  baseURL: string;
  apiKey: string;
}

export interface ProviderDiscoveryOptions {
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export class ProviderDiscoveryError extends Error {
  constructor(
    readonly kind: ProviderModelDiscoveryErrorKind,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ProviderDiscoveryError";
  }
}

/** 只保留 OpenAI 兼容协议；其余（Anthropic/Google）一律按 OpenAI 兼容口径处理。 */
export function inferProviderFromBaseURL(_baseURL: string): Provider {
  return "openai";
}

function endsWithVersionSegment(pathname: string): boolean {
  return /\/v\d+(?:beta\d*)?$/.test(pathname);
}

function joinURL(base: URL, path: string): string {
  const copy = new URL(base);
  const basePath = base.pathname.replace(/\/+$/, "");
  copy.pathname = `${basePath}/${path}`.replace(/\/{2,}/g, "/");
  return copy.toString();
}

/**
 * 生成待测端点阶梯（参考 cc-switch 的 build_models_url_candidates）：
 * 1. Base URL 原样拼列表路径（已是版本段 /v{N} 时拼 /models，否则拼 /v1/models）
 * 2. 根路径再兜底拼 /models（DeepSeek 直接在根目录暴露 /models）
 *
 * 去重且保持首次出现顺序——顺序即首选项，逐级尝试、首个成功即返回。
 */
export function buildModelEndpointProbes(baseURL: string, provider: Provider): ModelEndpointProbe[] {
  const probes: ModelEndpointProbe[] = [];
  const push = (url: string): void => {
    if (probes.some((probe) => probe.url === url)) return;
    probes.push({ url, dialect: "openai" satisfies ModelDialect, auth: "bearer" satisfies ModelAuthKind });
  };

  const base = new URL(baseURL.trim().replace(/\/+$/, ""));
  if (endsWithVersionSegment(base.pathname)) {
    push(joinURL(base, "models"));
    // 版本段非 /v1（如 /v1beta）时保留 /v1/models 作为兜底次候选
    if (!base.pathname.endsWith("/v1")) push(joinURL(base, "v1/models"));
  } else {
    push(joinURL(base, "v1/models"));
    push(joinURL(base, "models"));
  }

  // provider 参数保留在签名里（与旧调用一致），但不再影响方言
  void provider;

  return probes;
}

export async function discoverProviderModels(
  connection: ProviderDiscoveryConnection,
  options: ProviderDiscoveryOptions = {},
): Promise<DiscoveredModel[]> {
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? 12_000;
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const cancel = (): void => controller.abort();
  if (options.signal?.aborted) controller.abort();
  options.signal?.addEventListener("abort", cancel, { once: true });

  try {
    const probes = buildModelEndpointProbes(connection.baseURL, connection.provider);
    const models: DiscoveredModel[] = [];
    let lastError: ProviderDiscoveryError | undefined;
    for (const probe of probes) {
      if (controller.signal.aborted) break;
      try {
        models.push(...(await fetchModelPage(probe, connection.apiKey, options.fetchImpl ?? fetch, controller.signal)));
        break;
      } catch (error) {
        if (error instanceof ProviderDiscoveryError && error.kind === "authentication") throw error;
        lastError = error instanceof ProviderDiscoveryError
          ? error
          : new ProviderDiscoveryError("network", "Unable to connect to the service. Check the network and Base URL.", { cause: error });
      }
    }
    if (controller.signal.aborted) {
      throw new ProviderDiscoveryError(
        timedOut ? "timeout" : "cancelled",
        timedOut ? "Connection timed out. Try again." : "Model retrieval was cancelled.",
        { cause: lastError },
      );
    }
    const normalized = normalizeDiscoveredModels(models);
    if (normalized.length === 0) {
      // 所有候选都失败时，以最后一个候选的错误定级（network/unsupported/invalid_response）。
      // 401/403 已在循环内终止；候选为空或成功返回空列表时按 empty 处理。
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

export function discoveryErrorResult(
  error: unknown,
): Extract<ProviderModelDiscoveryResult, { ok: false }> {
  if (error instanceof ProviderDiscoveryError) {
    return { ok: false, error: error.kind, message: error.message };
  }
  return { ok: false, error: "network", message: error instanceof Error ? error.message : String(error) };
}

export function normalizeDiscoveredModels(models: unknown[]): DiscoveredModel[] {
  const unique = new Map<string, DiscoveredModel>();
  for (const value of models) {
    if (!value || typeof value !== "object") continue;
    const candidate = value as { id?: unknown; displayName?: unknown };
    const id = typeof candidate.id === "string" ? candidate.id.trim() : "";
    if (!id || unique.has(id)) continue;
    const displayName = typeof candidate.displayName === "string" && candidate.displayName.trim()
      ? candidate.displayName.trim()
      : id;
    unique.set(id, { id, displayName });
  }
  return [...unique.values()].sort((left, right) => left.id.localeCompare(right.id));
}

/** 按探测方言发起一次 GET 并处理该方言的分页循环。 */
async function fetchModelPage(
  probe: ModelEndpointProbe,
  apiKey: string,
  fetchImpl: typeof fetch,
  signal: AbortSignal,
): Promise<DiscoveredModel[]> {
  const models: DiscoveredModel[] = [];
  let url = probe.url;
  const origin = new URL(url).origin;
  const visited = new Set<string>();
  while (true) {
    if (visited.has(url)) throw new ProviderDiscoveryError("invalid_response", "The model list pagination cursor is invalid.");
    visited.add(url);
    const response = await fetchImpl(url, {
      method: "GET",
      headers: buildHeaders(probe.auth, apiKey),
      signal,
    });
    const failureKind = responseFailureKind(response);
    if (failureKind !== "ok") throw new ProviderDiscoveryError(failureKind, failureMessage(failureKind, response.status));
    const payload = await readJson(response);
    models.push(...parseModelPage(payload));
    const next = nextPageUrl(payload, url, origin);
    if (next === null) break;
    url = next;
  }
  return models;
}

function buildHeaders(auth: ModelAuthKind, apiKey: string): Record<string, string> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (auth === "bearer") headers.Authorization = `Bearer ${apiKey}`;
  return headers;
}

type ResponseFailure = "authentication" | "unsupported" | "network";

function responseFailureKind(response: Response): ResponseFailure | "ok" {
  if (response.ok) return "ok";
  if (response.status === 401 || response.status === 403) return "authentication";
  if (response.status === 404 || response.status === 405 || response.status === 501) return "unsupported";
  return "network";
}

function failureMessage(kind: ResponseFailure, status: number): string {
  if (kind === "authentication") return "The API Key is invalid or does not have access.";
  if (kind === "unsupported") return "This service does not support model list discovery.";
  return `The model list request failed with status code ${status}.`;
}

/** 解析 OpenAI 兼容方言的模型列表；结构不对抛 invalid_response。 */
function parseModelPage(payload: unknown): DiscoveredModel[] {
  if (!payload || typeof payload !== "object") {
    throw new ProviderDiscoveryError("invalid_response", "The model list response format is invalid.");
  }
  const list = (payload as { data?: unknown }).data;
  if (!Array.isArray(list)) {
    throw new ProviderDiscoveryError("invalid_response", "The model list response format is invalid.");
  }
  const models: DiscoveredModel[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const record = item as { id?: unknown; name?: unknown; display_name?: unknown };
    models.push({
      id: typeof record.id === "string" ? record.id : "",
      displayName: firstString(record.display_name, record.name, record.id),
    });
  }
  return models;
}

/** 返回下一页 URL；无更多页时返回 null；分页游标异常抛 invalid_response。 */
function nextPageUrl(
  payload: unknown,
  currentUrl: string,
  origin: string,
): string | null {
  const body = payload as Record<string, unknown>;
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

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch (error) {
    throw new ProviderDiscoveryError("invalid_response", "The model list response format is invalid.", { cause: error });
  }
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}
