import { useEffect, useMemo, useRef, useState } from "react";
import type {
  DiscoveredModel,
  ProviderModelState,
  ProviderProfileInput,
  ProviderProfileSummary,
} from "../../../shell/shared/ipc";
import { Icon } from "./Icon";

interface ModelDraft extends DiscoveredModel {
  available: boolean;
  selected: boolean;
  state: ProviderModelState;
}

interface ProviderEditorProps {
  profile?: ProviderProfileSummary;
  disabled: boolean;
  onCancel: () => void;
  onSaved: () => Promise<void>;
}

function initialModels(profile?: ProviderProfileSummary): ModelDraft[] {
  return profile?.models.map((model) => ({
    id: model.modelId,
    displayName: model.displayName,
    available: model.available,
    selected: model.imported,
    state: model.state,
  })) ?? [];
}

function createRequestId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `provider-discovery-${Date.now()}-${Math.random()}`;
}

export function ProviderEditor({ profile, disabled, onCancel, onSaved }: ProviderEditorProps) {
  const [providerName, setProviderName] = useState(profile?.name ?? "");
  const [baseURL, setBaseURL] = useState(profile?.baseURL ?? "");
  const [apiKey, setApiKey] = useState("");
  const [models, setModels] = useState<ModelDraft[]>(() => initialModels(profile));
  const [query, setQuery] = useState("");
  const [discovering, setDiscovering] = useState(false);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<string | null>(profile ? "已加载保存的模型。" : null);
  const [error, setError] = useState<string | null>(null);
  const activeRequest = useRef<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const selectAllRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    nameRef.current?.focus();
    return () => {
      if (activeRequest.current) window.agentAPI.cancelProviderModelDiscovery(activeRequest.current);
    };
  }, []);

  const visibleModels = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return models.filter((model) => (
      !normalized
      || model.id.toLowerCase().includes(normalized)
      || model.displayName.toLowerCase().includes(normalized)
    ));
  }, [models, query]);
  const selectedCount = models.filter((model) => model.selected).length;
  const allVisibleSelected = visibleModels.length > 0 && visibleModels.every((model) => model.selected);
  const someVisibleSelected = visibleModels.some((model) => model.selected);

  useEffect(() => {
    if (selectAllRef.current) selectAllRef.current.indeterminate = someVisibleSelected && !allVisibleSelected;
  }, [allVisibleSelected, someVisibleSelected]);

  const cancelDiscovery = (message = "已取消获取模型。"): void => {
    if (activeRequest.current) window.agentAPI.cancelProviderModelDiscovery(activeRequest.current);
    activeRequest.current = null;
    setDiscovering(false);
    setStatus(message);
    setError(null);
  };

  const discover = async (): Promise<void> => {
    if (!baseURL.trim()) {
      setError("请填写 API Base URL。");
      return;
    }
    if (!apiKey.trim() && !profile?.credentialConfigured) {
      setError("请填写 API Key。");
      return;
    }
    const requestId = createRequestId();
    activeRequest.current = requestId;
    setDiscovering(true);
    setStatus("正在获取模型列表。");
    setError(null);
    try {
      const result = await window.agentAPI.discoverProviderModels({
        requestId,
        providerProfileId: profile?.providerProfileId,
        providerName: providerName.trim(),
        baseURL: baseURL.trim(),
        apiKey: apiKey.trim() || undefined,
      });
      if (activeRequest.current !== requestId) return;
      if (!result.ok) {
        setError(result.message);
        setStatus(null);
        return;
      }
      const previous = new Map(models.map((model) => [model.id, model]));
      const remote = new Set(result.models.map((model) => model.id));
      const nextModels: ModelDraft[] = result.models.map((model) => {
        const saved = previous.get(model.id);
        return {
          ...model,
          available: true,
          selected: profile ? Boolean(saved?.selected) : true,
          state: saved?.selected ? "saved" : profile ? "new" : "saved",
        };
      });
      for (const model of models) {
        if (!model.selected || remote.has(model.id)) continue;
        nextModels.push({ ...model, available: false, state: "unavailable" });
      }
      setModels(nextModels);
      setStatus(`已获取 ${result.models.length} 个模型。`);
    } catch (cause) {
      if (activeRequest.current === requestId) {
        setError(cause instanceof Error ? cause.message : String(cause));
        setStatus(null);
      }
    } finally {
      if (activeRequest.current === requestId) {
        activeRequest.current = null;
        setDiscovering(false);
      }
    }
  };

  const save = async (): Promise<void> => {
    if (!providerName.trim()) {
      setError("请填写提供商名称。");
      return;
    }
    if (!baseURL.trim()) {
      setError("请填写 API Base URL。");
      return;
    }
    if (!profile && !apiKey.trim()) {
      setError("请填写 API Key。");
      return;
    }
    const selected = models.filter((model) => model.selected);
    if (!selected.length) {
      setError("请至少选择一个模型。");
      return;
    }
    const input: ProviderProfileInput = {
      providerProfileId: profile?.providerProfileId,
      name: providerName.trim(),
      baseURL: baseURL.trim(),
      apiKey: apiKey.trim() || undefined,
      models: selected.map((model) => ({ id: model.id, displayName: model.displayName, available: model.available })),
    };
    setSaving(true);
    setError(null);
    try {
      const result = await window.agentAPI.saveProvider(input);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setApiKey("");
      await onSaved();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  const locked = disabled || saving || discovering;

  return (
    <section className="provider-editor" aria-label={profile ? "编辑提供商" : "添加提供商"}>
      <header className="provider-editor-header">
        <button type="button" className="panel-close" onClick={onCancel} aria-label="返回提供商列表" title="返回提供商列表">
          <Icon name="chevron-left" width="16" height="16" />
        </button>
        <h3>{profile ? "编辑提供商" : "添加提供商"}</h3>
        <span className="header-spacer" />
      </header>

      <div className="provider-editor-body">
        <label className="field">
          <span className="field-label">提供商名称</span>
          <input ref={nameRef} type="text" value={providerName} disabled={locked} onChange={(event) => setProviderName(event.target.value)} placeholder="例如 OpenAI" />
        </label>

        <label className="field">
          <span className="field-label">API Base URL</span>
          <input type="url" value={baseURL} disabled={locked} onChange={(event) => setBaseURL(event.target.value)} placeholder="https://api.example.com/v1" spellCheck={false} />
        </label>

        <label className="field">
          <span className="field-label">API Key</span>
          <input type="password" value={apiKey} disabled={locked} onChange={(event) => setApiKey(event.target.value)} placeholder={profile ? "留空使用已保存凭据" : "输入 API Key"} autoComplete="off" spellCheck={false} />
        </label>

        <section className="model-import" aria-label="模型发现与导入">
          <div className="model-import-toolbar">
            <input className="model-search" type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索模型" aria-label="搜索模型" />
            <label className="select-all-models">
              <input ref={selectAllRef} type="checkbox" checked={allVisibleSelected} disabled={!visibleModels.length || locked} onChange={(event) => {
                const visible = new Set(visibleModels.map((model) => model.id));
                setModels((current) => current.map((model) => visible.has(model.id) ? { ...model, selected: event.target.checked } : model));
              }} />
              全选当前结果
            </label>
          </div>

          <div className="model-fetch-row">
            <button type="button" className="discover-button" onClick={() => void discover()} disabled={locked || !baseURL.trim() || (!apiKey.trim() && !profile?.credentialConfigured)}>
              {discovering ? <span className="spinner" /> : <Icon name="download" width="17" height="17" />}
              {discovering ? "正在获取" : "获取模型列表"}
            </button>
            {discovering && <button type="button" className="secondary-button" onClick={() => cancelDiscovery()}>取消获取</button>}
          </div>

          {(status || error) && <p className={error ? "form-error" : "form-status"} role={error ? "alert" : "status"}>{error && <Icon name="warning" width="15" height="15" />}{error ?? status}</p>}
          <span className="model-selection-count">选择 {selectedCount}/{models.length} 模型</span>

          <div className="discovered-model-list" role="group" aria-label="可导入模型">
            {!models.length && <div className="model-list-empty">尚无模型，请先获取模型列表。</div>}
            {visibleModels.map((model) => (
                <label className={`discovered-model-row ${model.state === "unavailable" ? "is-unavailable" : ""}`} key={model.id}>
                  <input type="checkbox" checked={model.selected} disabled={locked} onChange={(event) => setModels((current) => current.map((candidate) => candidate.id === model.id ? { ...candidate, selected: event.target.checked } : candidate))} />
                  <strong>{model.id}</strong>
                  {model.state === "new" && <span className="model-state is-new">新增</span>}
                  {model.state === "unavailable" && <span className="model-state is-unavailable">不可用</span>}
                </label>
            ))}
          </div>
        </section>
      </div>

      <footer className="provider-editor-actions">
        <button type="button" className="secondary-button" onClick={onCancel} disabled={saving}>取消</button>
        <button type="button" className="primary-button" onClick={() => void save()} disabled={disabled || saving || discovering || selectedCount === 0}>{saving ? "正在保存" : "保存提供商"}</button>
      </footer>
    </section>
  );
}
