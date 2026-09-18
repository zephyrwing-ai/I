import { useEffect, useMemo, useRef, useState } from "react";
import type {
  DiscoveredModel,
  ProviderModelState,
  ProviderProfileInput,
  ProviderProfileSummary,
} from "../../../shell/shared/ipc";
import { Icon } from "./Icon";

interface ModelDraft extends DiscoveredModel {
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
    selected: true,
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
  const [status, setStatus] = useState<string | null>(profile ? "Loaded saved models." : null);
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

  const cancelDiscovery = (message = "Model retrieval cancelled."): void => {
    if (activeRequest.current) window.agentAPI.cancelProviderModelDiscovery(activeRequest.current);
    activeRequest.current = null;
    setDiscovering(false);
    setStatus(message);
    setError(null);
  };

  const discover = async (): Promise<void> => {
    if (!baseURL.trim()) {
      setError("Enter an API Base URL.");
      return;
    }
    if (!apiKey.trim() && !profile?.credentialConfigured) {
      setError("Enter an API Key.");
      return;
    }
    const requestId = createRequestId();
    activeRequest.current = requestId;
    setDiscovering(true);
    setStatus("Loading model list.");
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
      const nextModels: ModelDraft[] = result.models.map((model) => {
        return {
          ...model,
          selected: true,
          state: "saved",
        };
      });
      setModels(nextModels);
      setStatus("Models loaded successfully.");
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
      setError("Enter a provider name.");
      return;
    }
    if (!baseURL.trim()) {
      setError("Enter an API Base URL.");
      return;
    }
    if (!profile && !apiKey.trim()) {
      setError("Enter an API Key.");
      return;
    }
    const selected = models.filter((model) => model.selected);
    if (!selected.length) {
      setError("Select at least one model.");
      return;
    }
    const input: ProviderProfileInput = {
      providerProfileId: profile?.providerProfileId,
      name: providerName.trim(),
      baseURL: baseURL.trim(),
      apiKey: apiKey.trim() || undefined,
      models: selected.map((model) => ({ id: model.id, displayName: model.displayName })),
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
    <section className="provider-editor" aria-label={profile ? "Edit provider" : "Add provider"}>
      <header className="provider-editor-header">
        <button type="button" className="panel-close" onClick={onCancel} aria-label="Back to providers" title="Back to providers">
          <Icon name="chevron-right" width="15" height="15" className="provider-back-icon" />
        </button>
        <h3>{profile ? "Edit provider" : "Add provider"}</h3>
        <span className="header-spacer" />
      </header>

      <div className="provider-editor-body">
        <label className="field">
          <span className="field-label">Provider name</span>
          <input ref={nameRef} type="text" value={providerName} disabled={locked} onChange={(event) => setProviderName(event.target.value)} placeholder="e.g. OpenAI" />
        </label>

        <label className="field">
          <span className="field-label">API Base URL</span>
          <input type="url" value={baseURL} disabled={locked} onChange={(event) => setBaseURL(event.target.value)} placeholder="https://api.example.com/v1" spellCheck={false} />
        </label>

        <label className="field">
          <span className="field-label">API Key</span>
          <input type="password" value={apiKey} disabled={locked} onChange={(event) => setApiKey(event.target.value)} placeholder={profile ? "Leave blank to use saved credentials" : "Enter an API Key"} autoComplete="off" spellCheck={false} />
        </label>

        <section className="model-import" aria-label="Model discovery and import">
          <div className="model-import-toolbar">
            <input className="model-search" type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search models" aria-label="Search models" />
            <label className="select-all-models">
              <input ref={selectAllRef} type="checkbox" checked={allVisibleSelected} disabled={!visibleModels.length || locked} onChange={(event) => {
                const visible = new Set(visibleModels.map((model) => model.id));
                setModels((current) => current.map((model) => visible.has(model.id) ? { ...model, selected: event.target.checked } : model));
              }} />
              Select all visible results
            </label>
          </div>

          <div className="model-fetch-row">
            <button type="button" className="discover-button" onClick={() => void discover()} disabled={locked || !baseURL.trim() || (!apiKey.trim() && !profile?.credentialConfigured)}>
              {discovering ? <span className="spinner" /> : <Icon name="download" width="17" height="17" />}
              {discovering ? "Fetching" : "Fetch model list"}
            </button>
            {discovering && <button type="button" className="secondary-button" onClick={() => cancelDiscovery()}>Cancel</button>}
          </div>

          {(status || error) && <p className={error ? "form-error" : "form-status"} role={error ? "alert" : "status"}>{error && <Icon name="warning" width="15" height="15" />}{error ?? status}</p>}
          <span className="model-selection-count">Selected {selectedCount}/{models.length} models</span>

          <div className="discovered-model-list" role="group" aria-label="Importable models">
            {!models.length && <div className="model-list-empty">No models yet. Fetch the model list first.</div>}
            {visibleModels.map((model) => (
                <label className="discovered-model-row" key={model.id}>
                  <input type="checkbox" checked={model.selected} disabled={locked} onChange={(event) => setModels((current) => current.map((candidate) => candidate.id === model.id ? { ...candidate, selected: event.target.checked } : candidate))} />
                  <strong>{model.id}</strong>
                </label>
            ))}
          </div>
        </section>
      </div>

      <footer className="provider-editor-actions">
        <button type="button" className="secondary-button" onClick={onCancel} disabled={saving}>Cancel</button>
        <button type="button" className="primary-button" onClick={() => void save()} disabled={disabled || saving || discovering || selectedCount === 0}>{saving ? "Saving" : "Save provider"}</button>
      </footer>
    </section>
  );
}
