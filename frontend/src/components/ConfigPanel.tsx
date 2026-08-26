import type { Provider } from "../../../shell/shared/ipc";
import { PROVIDERS, type RunSettings } from "../store/runSettings";

interface ConfigPanelProps {
  settings: RunSettings;
  onChange: (s: RunSettings) => void;
  disabled: boolean;
}

/** 右侧 Inspector — 集中管理运行配置，含 API Key 输入（deepseek 得以打通）。 */
export function ConfigPanel({ settings, onChange, disabled }: ConfigPanelProps) {
  const set = <K extends keyof RunSettings>(key: K, value: RunSettings[K]): void => {
    onChange({ ...settings, [key]: value });
  };

  const changeProvider = (p: Provider): void => {
    onChange({ ...settings, provider: p, model: PROVIDERS[p].defaultModel, baseURL: PROVIDERS[p].baseURL });
  };

  const pickDirectory = async (): Promise<void> => {
    const dir = await window.agentAPI.selectDirectory();
    if (dir) onChange({ ...settings, cwd: dir });
  };

  return (
    <aside className="config-panel">
      <header className="config-header">设置</header>

      <section className="config-section">
        <label className="field">
          <span className="field-label">Provider</span>
          <select value={settings.provider} disabled={disabled} onChange={(e) => changeProvider(e.target.value as Provider)}>
            {(Object.keys(PROVIDERS) as Provider[]).map((p) => (
              <option key={p} value={p}>
                {PROVIDERS[p].label}
              </option>
            ))}
          </select>
        </label>

        <label className="field">
          <span className="field-label">Model</span>
          <input value={settings.model} disabled={disabled} onChange={(e) => set("model", e.target.value)} spellCheck={false} />
        </label>

        {settings.provider === "openai" && (
          <>
            <label className="field">
              <span className="field-label">Base URL</span>
              <input value={settings.baseURL} disabled={disabled} onChange={(e) => set("baseURL", e.target.value)} spellCheck={false} />
            </label>
            <label className="field">
              <span className="field-label">API Key</span>
              <input
                value={settings.apiKey}
                type="password"
                placeholder="sk-…"
                disabled={disabled}
                onChange={(e) => set("apiKey", e.target.value)}
                spellCheck={false}
                autoComplete="off"
              />
            </label>
          </>
        )}
      </section>

      <section className="config-section">
        <label className="field field-inline">
          <input type="checkbox" checked={settings.useDocker} disabled={disabled} onChange={(e) => set("useDocker", e.target.checked)} />
          <span className="field-label">用 Docker 运行命令</span>
        </label>

        <label className="field">
          <span className="field-label">Steps 上限</span>
          <input
            type="number"
            min={1}
            max={100}
            value={settings.stepLimit}
            disabled={disabled}
            onChange={(e) => set("stepLimit", Math.max(1, Number(e.target.value) || 1))}
          />
        </label>
      </section>

      <section className="config-section">
        <span className="field-label">工作目录</span>
        <div className="workspace-row">
          <button className="ghost-btn" onClick={pickDirectory} disabled={disabled}>
            选择目录
          </button>
          <span className="workspace-path" title={settings.cwd}>
            {settings.cwd || "未选择"}
          </span>
        </div>
      </section>
    </aside>
  );
}
