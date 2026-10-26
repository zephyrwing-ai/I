import { useEffect, useState } from "react";
import type { VoiceModelSummary } from "../../../../../shell/shared/ipc";
import { useI18n } from "../../../shared/i18n";
import "./VoiceSettings.css";

export function VoiceSettings() {
  const t = useI18n();
  const [models, setModels] = useState<VoiceModelSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let disposed = false;
    if (typeof window.agentAPI?.listVoiceModels !== "function") {
      setModels([]);
      setError("Voice models could not be loaded.");
      return;
    }
    const refresh = async (): Promise<void> => {
      try {
        const list = await window.agentAPI.listVoiceModels();
        if (!disposed) setModels(list);
      } catch {
        if (!disposed) setError("Voice models could not be loaded.");
      }
    };
    let lastScanAt = 0;
    const scan = (): void => {
      if (Date.now() - lastScanAt < 30_000) return;
      lastScanAt = Date.now();
      if (typeof window.agentAPI.scanVoiceModels !== "function") return;
      void window.agentAPI.scanVoiceModels().then((result) => {
        if (disposed) return;
        if (!result.ok) {
          setError(result.error);
          return;
        }
        void refresh();
      });
    };
    void refresh();
    scan();
    window.addEventListener("focus", scan);
    const unsubscribe = typeof window.agentAPI.onVoiceModelEvent === "function"
      ? window.agentAPI.onVoiceModelEvent((event) => {
          setModels((current) => current?.map((model) => (
            model.id === event.modelId
              ? { ...model, status: event.status, progress: event.progress }
              : model
          )) ?? current);
        })
      : () => undefined;
    return () => {
      disposed = true;
      window.removeEventListener("focus", scan);
      unsubscribe();
    };
  }, []);

  const toggleDownload = (model: VoiceModelSummary): void => {
    if (model.status === "downloading") {
      window.agentAPI.cancelVoiceModelDownload(model.id);
      return;
    }
    void window.agentAPI.downloadVoiceModel(model.id).then((result) => {
      setError(result.ok ? null : result.error);
    });
  };

  const select = (model: VoiceModelSummary): void => {
    void window.agentAPI.selectVoiceModel(model.id).then((result) => {
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setError(null);
      void window.agentAPI.listVoiceModels().then(setModels).catch(() => {
        setError("Voice models could not be loaded.");
      });
    });
  };

  return (
    <section className="settings-section voice-settings" aria-labelledby="settings-voice-title">
      <header className="settings-section-header">
        <h1 id="settings-voice-title">{t("Voice")}</h1>
      </header>
      {models === null ? (
        <p className="voice-settings-status">…</p>
      ) : (
        <div className="voice-model-list">
          {models.map((model) => (
            <div key={model.id} className={`voice-model-card${model.selected ? " selected" : ""}`}>
              <button
                type="button"
                className={`voice-model-radio${model.status === "installed" ? " visible" : ""}${model.selected ? " checked" : ""}`}
                onClick={() => select(model)}
                disabled={model.status !== "installed"}
                aria-label={`Use ${model.name}`}
                aria-pressed={model.selected}
                title="Use model"
              />
              <div className="voice-model-info">
                <div className="voice-model-title">
                  <span className="voice-model-name">{model.name}</span>
                  <span className="voice-model-tag">{model.tag}</span>
                  {model.recommended && <span className="voice-model-recommended">{t("Recommended")}</span>}
                </div>
                <div className="voice-model-metrics">
                  <span className="voice-model-metric"><b>{model.sizeLabel}</b> size</span>
                  <span className="voice-model-approx">≈</span>
                  <span className="voice-model-metric"><b>{model.ramLabel}</b> RAM</span>
                  <span className="voice-model-metric voice-model-speed">
                    {t("Speed")}
                    <span className="voice-model-speed-dots" aria-label={`Speed ${model.speedLevel} of 5`}>
                      {Array.from({ length: 5 }, (_, index) => (
                        <i key={index} className={index < model.speedLevel ? "on" : ""} />
                      ))}
                    </span>
                  </span>
                  {model.wer && <span className="voice-model-metric">WER <b>{model.wer}</b></span>}
                </div>
              </div>
              <button
                type="button"
                className={`voice-model-action${model.status === "downloading" ? " downloading" : ""}`}
                onClick={() => toggleDownload(model)}
                disabled={model.status === "installed"}
              >
                {model.status === "not_downloaded" && "Download"}
                {model.status === "downloading" && (model.progress === null ? "…" : `${model.progress}%`)}
                {model.status === "installed" && "Installed"}
              </button>
            </div>
          ))}
        </div>
      )}
      {error && <p className="voice-settings-error" role="status">{error}</p>}
    </section>
  );
}
