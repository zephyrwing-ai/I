import { useEffect, useRef, useState } from "react";
import type { ProviderProfileSummary } from "../../../shell/shared/ipc";
import { Icon } from "./Icon";
import { ProviderEditor } from "./ProviderEditor";

interface ConfigPanelProps {
  profiles: ProviderProfileSummary[];
  loading: boolean;
  error: string | null;
  disabled: boolean;
  onClose: () => void;
  onRefresh: () => Promise<void>;
}

type PanelMode =
  | { kind: "list" }
  | { kind: "create" }
  | { kind: "edit"; profile: ProviderProfileSummary };

type RefreshState = { kind: "loading" | "success" | "error"; message?: string };

export function ConfigPanel({ profiles, loading, error, disabled, onClose, onRefresh }: ConfigPanelProps) {
  const [mode, setMode] = useState<PanelMode>({ kind: "list" });
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [refreshStates, setRefreshStates] = useState<Record<string, RefreshState>>({});
  const deleteTimer = useRef<number | null>(null);
  const feedbackTimers = useRef<Map<string, number>>(new Map());

  useEffect(() => () => {
    if (deleteTimer.current !== null) window.clearTimeout(deleteTimer.current);
    feedbackTimers.current.forEach((timer) => window.clearTimeout(timer));
  }, []);

  const resetDelete = (): void => {
    if (deleteTimer.current !== null) window.clearTimeout(deleteTimer.current);
    deleteTimer.current = null;
    setConfirmDelete(null);
  };

  const remove = async (profile: ProviderProfileSummary): Promise<void> => {
    if (confirmDelete !== profile.providerProfileId) {
      resetDelete();
      setConfirmDelete(profile.providerProfileId);
      deleteTimer.current = window.setTimeout(() => {
        deleteTimer.current = null;
        setConfirmDelete(null);
      }, 4_000);
      return;
    }
    resetDelete();
    setDeleteError(null);
    const result = await window.agentAPI.deleteProvider(profile.providerProfileId);
    if (!result.ok) {
      setDeleteError(result.error);
      return;
    }
    setExpanded((current) => {
      const next = new Set(current);
      next.delete(profile.providerProfileId);
      return next;
    });
    await onRefresh();
  };

  const refreshProfile = async (profile: ProviderProfileSummary): Promise<void> => {
    resetDelete();
    setRefreshStates((current) => ({ ...current, [profile.providerProfileId]: { kind: "loading" } }));
    const result = await window.agentAPI.refreshProviderModels(profile.providerProfileId);
    if (!result.ok) {
      setRefreshStates((current) => ({ ...current, [profile.providerProfileId]: { kind: "error", message: result.message } }));
      return;
    }
    await onRefresh();
    setRefreshStates((current) => ({ ...current, [profile.providerProfileId]: { kind: "success" } }));
    const existingTimer = feedbackTimers.current.get(profile.providerProfileId);
    if (existingTimer) window.clearTimeout(existingTimer);
    feedbackTimers.current.set(profile.providerProfileId, window.setTimeout(() => {
      setRefreshStates((current) => {
        const next = { ...current };
        delete next[profile.providerProfileId];
        return next;
      });
      feedbackTimers.current.delete(profile.providerProfileId);
    }, 2_200));
  };

  if (mode.kind !== "list") {
    return (
      <ProviderEditor
        profile={mode.kind === "edit" ? mode.profile : undefined}
        disabled={disabled}
        onCancel={() => setMode({ kind: "list" })}
        onSaved={async () => {
          await onRefresh();
          setMode({ kind: "list" });
        }}
      />
    );
  }

  return (
    <section className="config-panel" role="dialog" aria-modal="false" aria-labelledby="provider-settings-title">
      <header className="config-header">
        <h2 id="provider-settings-title">Providers</h2>
        <button type="button" className="panel-close" onClick={onClose} aria-label="Close settings" title="Close settings"><Icon name="close" width="16" height="16" /></button>
      </header>

      <div className="provider-list">
        {loading && <p className="panel-empty">Loading providers.</p>}
        {!loading && profiles.length === 0 && <p className="panel-empty">No providers added. Add and save a provider to make its models available in Composer.</p>}
        {profiles.map((profile) => {
          const isExpanded = expanded.has(profile.providerProfileId);
          const refreshState = refreshStates[profile.providerProfileId];
          return (
            <article className={`provider-card ${isExpanded ? "is-expanded" : ""}`} key={profile.providerProfileId}>
              <div className="provider-card-heading">
                <button type="button" className="provider-card-toggle" aria-expanded={isExpanded} onClick={() => {
                  resetDelete();
                  setExpanded((current) => {
                    const next = new Set(current);
                    if (next.has(profile.providerProfileId)) next.delete(profile.providerProfileId);
                    else next.add(profile.providerProfileId);
                    return next;
                  });
                }}>
                  <span className="provider-card-chevron"><Icon name="chevron-right" width="15" height="15" /></span>
                  <span className="provider-card-identity">
                    <strong>{profile.name}</strong>
                  </span>
                </button>
                <div className="provider-card-actions">
                  <button type="button" className={refreshState?.kind === "loading" ? "is-refreshing" : ""} onClick={() => void refreshProfile(profile)} disabled={disabled || refreshState?.kind === "loading"} aria-label={`Refresh ${profile.name} models`} title="Refresh models"><Icon name="refresh" width="16" height="16" strokeWidth={2} /></button>
                  <button type="button" onClick={() => { resetDelete(); setMode({ kind: "edit", profile }); }} disabled={disabled} aria-label={`Edit ${profile.name}`} title="Edit provider"><Icon name="edit" width="16" height="16" strokeWidth={2} /></button>
                  <button type="button" className={confirmDelete === profile.providerProfileId ? "danger-confirm" : ""} onClick={() => void remove(profile)} disabled={disabled} aria-label={confirmDelete === profile.providerProfileId ? `Click again to delete ${profile.name}` : `Delete ${profile.name}`} title={confirmDelete === profile.providerProfileId ? "Click again to confirm deletion" : "Delete provider"}><Icon name="trash" width="16" height="16" /></button>
                </div>
              </div>

              <div className={`provider-feedback ${refreshState?.kind === "success" ? "is-visible" : ""}`} role="status">Refresh succeeded</div>
              {refreshState?.kind === "error" && <p className="provider-refresh-error" role="alert">{refreshState.message}</p>}

              <div className="provider-model-collapse" aria-hidden={!isExpanded}>
                <div className="provider-model-clip">
                  <ul className="provider-models">
                    {profile.models.map((model) => (
                      <li key={model.modelOptionId}>
                        <span>{model.modelId}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            </article>
          );
        })}
      </div>

      {(error || deleteError) && <p className="form-error" role="alert"><Icon name="warning" width="15" height="15" />{deleteError ?? error}</p>}
      <footer className="config-actions"><button type="button" className="primary-button add-provider-button" onClick={() => { resetDelete(); setMode({ kind: "create" }); }} disabled={disabled}>Add provider</button></footer>
    </section>
  );
}
