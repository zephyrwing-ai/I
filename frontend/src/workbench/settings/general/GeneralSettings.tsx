import { useI18n } from "../../../shared/i18n";
import { useUiPreferences } from "../../../shared/preferences/uiPreferences";
import { Select } from "../../../shared/ui/Select";
import { DocumentProcessingSettings } from "./DocumentProcessingSettings";
import "./GeneralSettings.css";

export function GeneralSettings({ disabled = false }: { disabled?: boolean }) {
  const t = useI18n();
  const { appearance, language, error, setAppearance, setLanguage } = useUiPreferences();

  return (
    <section className="settings-section" aria-labelledby="settings-general-title">
      <header className="settings-section-header">
        <h1 id="settings-general-title">{t("General")}</h1>
      </header>
      <dl className="settings-general-list">
        <div className="settings-general-row">
          <dt><span id="settings-appearance-label">{t("Appearance")}</span></dt>
          <dd><Select id="settings-appearance" labelledBy="settings-appearance-label" value={appearance} onValueChange={setAppearance} options={[
            { value: "system", label: t("System") },
            { value: "light", label: t("Light") },
            { value: "dark", label: t("Dark") },
          ]} /></dd>
        </div>
        <div className="settings-general-row">
          <dt><span id="settings-language-label">{t("Language")}</span></dt>
          <dd><Select id="settings-language" labelledBy="settings-language-label" value={language} onValueChange={setLanguage} options={[
            { value: "en", label: "English" },
            { value: "zh-CN", label: "简体中文" },
          ]} /></dd>
        </div>
        <DocumentProcessingSettings disabled={disabled} />
      </dl>
      {error && <p className="form-error" role="alert">{t(error)}</p>}
    </section>
  );
}
