import { useI18n } from "../../../shared/i18n";
import { useEffect, useMemo, useRef, useState } from "react";
import type {
  DiscoveredModel,
  ProviderModelState,
  ProviderProfileInput,
  ProviderProfileSummary,
} from "../../../../../shell/shared/ipc";
import { haveSameProviderOrigin } from "../../../../../shell/shared/provider-origin";
import { Icon } from "../../../shared/ui/Icon";

interface ModelDraft extends DiscoveredModel {
  selected: boolean;
  state: ProviderModelState;
  capabilityInputs?: { contextWindowTokens: string; maxOutputTokens: string; origin?: string };
  capabilityOrigin?: string;
}

interface ProviderEditorProps {
  profile?: ProviderProfileSummary;
  disabled: boolean;
  onCancel: () => void;
  onSaved: () => Promise<void>;
}

export function initialModels(profile?: ProviderProfileSummary): ModelDraft[] {
  return profile?.models.map((model) => ({
    id: model.modelId,
    displayName: model.displayName,
    capabilities: model.capabilities,
    capabilityOrigin: profile?.baseURL,
    selected: true,
    state: model.state,
  })) ?? [];
}

export function providerModelsForSave(models: readonly ModelDraft[], baseURL?: string): DiscoveredModel[] {
  return models.filter((model) => model.selected).map((model) => {
    let capabilities = baseURL && model.capabilityOrigin && !haveSameProviderOrigin(model.capabilityOrigin, baseURL)
      ? undefined : model.capabilities;
    const inputs = model.capabilityInputs;
    if (inputs && (!baseURL || !inputs.origin || haveSameProviderOrigin(inputs.origin, baseURL))) {
      const positiveTokens = (value: string, label: string): number => {
        const trimmed = value.trim();
        const parsed = Number(trimmed);
        if (!/^\d+$/.test(trimmed) || !Number.isSafeInteger(parsed) || parsed <= 0) {
          throw new Error(`${model.id}: enter a positive whole number for ${label}.`);
        }
        return parsed;
      };
      const contextWindowTokens = positiveTokens(inputs.contextWindowTokens, "context window tokens");
      const output = inputs.maxOutputTokens.trim();
      const maxOutputTokens = output ? positiveTokens(output, "max output tokens") : undefined;
      if (maxOutputTokens !== undefined && maxOutputTokens > contextWindowTokens) {
        throw new Error(`${model.id}: max output tokens must fit within the context window.`);
      }
      capabilities = { ...capabilities, contextWindowTokens, maxOutputTokens, source: "manual" };
    }
    return { id: model.id, displayName: model.displayName, capabilities };
  });
}

function capabilityValue(model: ModelDraft, field: "contextWindowTokens" | "maxOutputTokens", baseURL: string): string {
  if (model.capabilityInputs && (!model.capabilityInputs.origin || haveSameProviderOrigin(model.capabilityInputs.origin, baseURL))) {
    return model.capabilityInputs[field];
  }
  return !model.capabilityOrigin || haveSameProviderOrigin(model.capabilityOrigin, baseURL)
    ? String(model.capabilities?.[field] ?? "") : "";
}

function createRequestId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `provider-discovery-${Date.now()}-${Math.random()}`;
}

export function ProviderEditor({ profile, disabled, onCancel, onSaved }: ProviderEditorProps) {
  const t = useI18n();
  const [providerName, setProviderName] = useState(profile?.name ?? "");
  const [baseURL, setBaseURL] = useState(profile?.baseURL ?? "");
  const [apiKey, setApiKey] = useState("");
  const [showApiKey, setShowApiKey] = useState(false);
  const [models, setModels] = useState<ModelDraft[]>(() => initialModels(profile));
  const [query, setQuery] = useState("");
  const [discovering, setDiscovering] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fetchSuccess, setFetchSuccess] = useState(false);
  const activeRequest = useRef<string | null>(null);
  const fetchFeedbackTimer = useRef<number | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const selectAllRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    nameRef.current?.focus();
    return () => {
      if (activeRequest.current) window.agentAPI.cancelProviderModelDiscovery(activeRequest.current);
      if (fetchFeedbackTimer.current !== null) window.clearTimeout(fetchFeedbackTimer.current);
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
  const savedCredentialUsable = Boolean(profile?.credentialConfigured
    && haveSameProviderOrigin(profile.baseURL, baseURL));
  const needsCredentialForAddress = Boolean(profile?.credentialConfigured && !savedCredentialUsable);
  const hasCredential = Boolean(apiKey.trim()) || savedCredentialUsable;

  useEffect(() => {
    if (selectAllRef.current) selectAllRef.current.indeterminate = someVisibleSelected && !allVisibleSelected;
  }, [allVisibleSelected, someVisibleSelected]);

  const cancelDiscovery = (): void => {
    if (activeRequest.current) window.agentAPI.cancelProviderModelDiscovery(activeRequest.current);
    activeRequest.current = null;
    setDiscovering(false);
    setError(null);
  };

  const discover = async (): Promise<void> => {
    if (!baseURL.trim()) {
      setError("Enter an API Base URL.");
      return;
    }
    if (!hasCredential) {
      setError(needsCredentialForAddress ? "Enter an API Key for the new provider address." : "Enter an API Key.");
      return;
    }
    const requestId = createRequestId();
    activeRequest.current = requestId;
    setDiscovering(true);
    setFetchSuccess(false);
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
        return;
      }
      const nextModels: ModelDraft[] = result.models.map((model) => {
        return {
          ...model,
          capabilityOrigin: baseURL.trim(),
          selected: true,
          state: "saved",
        };
      });
      setModels(nextModels);
      setFetchSuccess(true);
      if (fetchFeedbackTimer.current !== null) window.clearTimeout(fetchFeedbackTimer.current);
      fetchFeedbackTimer.current = window.setTimeout(() => {
        fetchFeedbackTimer.current = null;
        setFetchSuccess(false);
      }, 2_200);
    } catch (cause) {
      if (activeRequest.current === requestId) {
        setError(cause instanceof Error ? cause.message : String(cause));
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
    if (!hasCredential) {
      setError(needsCredentialForAddress ? "Enter an API Key for the new provider address." : "Enter an API Key.");
      return;
    }
    if (!selectedCount) {
      setError("Select at least one model.");
      return;
    }
    let selectedModels: DiscoveredModel[];
    try {
      selectedModels = providerModelsForSave(models, baseURL.trim());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return;
    }
    const input: ProviderProfileInput = {
      providerProfileId: profile?.providerProfileId,
      name: providerName.trim(),
      baseURL: baseURL.trim(),
      apiKey: apiKey.trim() || undefined,
      models: selectedModels,
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
  const updateCapability = (id: string, field: "contextWindowTokens" | "maxOutputTokens", value: string): void => {
    setModels((current) => current.map((model) => model.id === id ? {
      ...model,
      capabilityInputs: {
        contextWindowTokens: capabilityValue(model, "contextWindowTokens", baseURL),
        maxOutputTokens: capabilityValue(model, "maxOutputTokens", baseURL),
        origin: baseURL,
        [field]: value,
      },
    } : model));
  };

  return (
    <section className="provider-editor" aria-label={t(profile ? "Edit provider" : "Add provider")}>
      <header className="provider-editor-header">
        <button type="button" className="panel-close" onClick={onCancel} aria-label={t("Back to providers")} title={t("Back to providers")}>
          <Icon name="chevron-right" width="15" height="15" className="provider-back-icon" />
        </button>
        <h3>{t(profile ? "Edit provider" : "Add provider")}</h3>
        <span className="header-spacer" />
      </header>

      <div className="provider-editor-body">
        <label className="field">
          <span className="field-label">{t("Provider name")}</span>
          <input ref={nameRef} type="text" value={providerName} disabled={locked} onChange={(event) => setProviderName(event.target.value)} placeholder={t("e.g. OpenAI")} />
        </label>

        <label className="field">
          <span className="field-label">{t("API Base URL")}</span>
          <input type="url" value={baseURL} disabled={locked} onChange={(event) => setBaseURL(event.target.value)} placeholder="https://api.example.com/v1" spellCheck={false} />
        </label>

        <div className="field">
          <label className="field-label" htmlFor="provider-api-key">API Key</label>
          <div className="secret-input-wrap">
            <input id="provider-api-key" className="secret-input" type={showApiKey ? "text" : "password"} value={apiKey} disabled={locked} onChange={(event) => setApiKey(event.target.value)} placeholder={t(savedCredentialUsable ? "Leave blank to use saved credentials" : "Enter an API Key")} aria-describedby={needsCredentialForAddress ? "provider-credential-hint" : undefined} autoComplete="off" spellCheck={false} />
            <button type="button" className="secret-toggle" onClick={() => setShowApiKey((visible) => !visible)} disabled={locked} aria-label={t(showApiKey ? "Hide API Key" : "Show API Key")} title={t(showApiKey ? "Hide API Key" : "Show API Key")}>
              <Icon name={showApiKey ? "eye-off" : "eye"} width="16" height="16" />
            </button>
          </div>
          {needsCredentialForAddress && <p id="provider-credential-hint" className="form-status" role="status">{t("Enter an API Key for the new provider address.")}</p>}
        </div>

        <section className="model-import" aria-label={t("Model discovery and import")}>
          <div className="model-import-toolbar">
            <input className="model-search" type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("Search models")} aria-label={t("Search models")} />
            <label className="select-all-models">
              <input ref={selectAllRef} type="checkbox" checked={allVisibleSelected} disabled={!visibleModels.length || locked} onChange={(event) => {
                const visible = new Set(visibleModels.map((model) => model.id));
                setModels((current) => current.map((model) => visible.has(model.id) ? { ...model, selected: event.target.checked } : model));
              }} />
              {t("Select all visible results")}
            </label>
          </div>

          <div className="model-fetch-row">
            <button type="button" className={`discover-button${fetchSuccess ? " is-fetch-success" : ""}`} onClick={() => void discover()} disabled={locked || !baseURL.trim() || !hasCredential}>
              {discovering ? <span className="spinner" /> : <Icon name={fetchSuccess ? "check" : "download"} width="17" height="17" strokeWidth={2} />}
              {t(discovering ? "Fetching" : "Fetch model list")}
            </button>
            {discovering && <button type="button" className="secondary-button" onClick={() => cancelDiscovery()}>{t("Cancel")}</button>}
          </div>

          {error && <p className="form-error" role="alert"><Icon name="warning" width="15" height="15" />{t(error)}</p>}
          <span className="model-selection-count">{t("Selected {selected}/{total} models", { selected: selectedCount, total: models.length })}</span>

          <div className="discovered-model-list" role="group" aria-label={t("Importable models")}>
            {!models.length && <div className="model-list-empty">{t("No models yet. Fetch the model list first.")}</div>}
            {visibleModels.map((model) => (
              <div className="discovered-model-item" key={model.id}>
                <label className="discovered-model-row">
                  <input type="checkbox" checked={model.selected} disabled={locked} onChange={(event) => setModels((current) => current.map((candidate) => candidate.id === model.id ? { ...candidate, selected: event.target.checked } : candidate))} />
                  <strong>{model.id}</strong>
                </label>
                <details className="model-capabilities">
                  <summary>{t("Model limits")}</summary>
                  <div className="model-capability-fields">
                    <label className="field">
                      <span className="field-label">{t("Context window tokens")}</span>
                      <input type="text" inputMode="numeric" aria-label={t("Context window tokens for {name}", { name: model.id })} value={capabilityValue(model, "contextWindowTokens", baseURL)} placeholder={t("Unknown")} disabled={locked} onChange={(event) => updateCapability(model.id, "contextWindowTokens", event.target.value)} />
                    </label>
                    <label className="field">
                      <span className="field-label">{t("Max output tokens (optional)")}</span>
                      <input type="text" inputMode="numeric" aria-label={t("Max output tokens for {name}", { name: model.id })} value={capabilityValue(model, "maxOutputTokens", baseURL)} placeholder={t("Unknown")} disabled={locked} onChange={(event) => updateCapability(model.id, "maxOutputTokens", event.target.value)} />
                    </label>
                  </div>
                </details>
              </div>
            ))}
          </div>
        </section>
      </div>

      <footer className="provider-editor-actions">
        <button type="button" className="secondary-button" onClick={onCancel} disabled={saving}>{t("Cancel")}</button>
        <button type="button" className="primary-button" onClick={() => void save()} disabled={locked || !hasCredential || selectedCount === 0}>{t(saving ? "Saving" : "Save provider")}</button>
      </footer>
    </section>
  );
}
