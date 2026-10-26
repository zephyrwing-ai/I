import { useEffect, useRef } from "react";
import type { ProviderProfileSummary } from "../../../../shell/shared/ipc";
import { GeneralSettings } from "./general/GeneralSettings";
import { ConfigPanel } from "./providers/ConfigPanel";
import { VoiceSettings } from "./voice/VoiceSettings";
import { Icon } from "../../shared/ui/Icon";
import { useI18n } from "../../shared/i18n";
import "./SettingsPage.css";

export type SettingsSection = "general" | "providers" | "usage" | "tts" | "voice";

interface SettingsPageProps {
  section: SettingsSection;
  profiles: ProviderProfileSummary[];
  loading: boolean;
  error: string | null;
  disabled: boolean;
  onSectionChange: (section: SettingsSection) => void;
  onBack: () => void;
  onRefresh: () => Promise<void>;
}

export function SettingsPage({
  section,
  profiles,
  loading,
  error,
  disabled,
  onSectionChange,
  onBack,
  onRefresh,
}: SettingsPageProps) {
  const t = useI18n();
  const backRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    backRef.current?.focus();
  }, []);

  return (
    <section className="settings-page" aria-label={t("Settings")}>
      <aside className="settings-page-sidebar">
        <div className="settings-page-titlebar" aria-hidden="true" />
        <div className="settings-page-navigation">
          <button ref={backRef} type="button" className="settings-page-back" aria-label={t("Back to workbench")} onClick={onBack}>
            <Icon name="chevron-right" width="15" height="15" className="settings-page-back-icon" />
            <span>{t("Back")}</span>
          </button>
          <nav className="settings-page-nav" aria-label={t("Settings sections")}>
            <SettingsNavItem section="general" active={section === "general"} label={t("General")} icon="settings" onClick={onSectionChange} />
            <SettingsNavItem section="providers" active={section === "providers"} label={t("Providers")} icon="terminal" onClick={onSectionChange} />
            <SettingsNavItem section="usage" active={section === "usage"} label={t("Usage")} icon="tool" onClick={onSectionChange} />
            <SettingsNavItem section="tts" active={section === "tts"} label={t("TTS")} icon="microphone" onClick={onSectionChange} />
            <SettingsNavItem section="voice" active={section === "voice"} label={t("Voice")} icon="microphone" onClick={onSectionChange} />
          </nav>
        </div>
      </aside>

      <main className="settings-page-main">
        <div className="settings-page-titlebar" aria-hidden="true" />
        <div key={section} id={`settings-content-${section}`} className="settings-page-content">
          {section === "general" && <GeneralSettings disabled={disabled} />}
          {section === "providers" && (
            <section className="settings-section" aria-labelledby="settings-providers-title">
              <header className="settings-section-header">
                <h1 id="settings-providers-title">{t("Providers")}</h1>
              </header>
              <ConfigPanel
                embedded
                profiles={profiles}
                loading={loading}
                error={error}
                disabled={disabled}
                onClose={onBack}
                onRefresh={onRefresh}
              />
            </section>
          )}
          {section === "usage" && <SettingsPlaceholder title="Usage" />}
          {section === "tts" && <SettingsPlaceholder title="TTS" />}
          {section === "voice" && <VoiceSettings />}
        </div>
      </main>
    </section>
  );
}

function SettingsNavItem({
  section,
  active,
  label,
  icon,
  onClick,
}: {
  section: SettingsSection;
  active: boolean;
  label: string;
  icon: "settings" | "terminal" | "tool" | "microphone";
  onClick: (section: SettingsSection) => void;
}) {
  return (
    <button type="button" id={`settings-nav-${section}`} className={`settings-page-nav-item${active ? " active" : ""}`} aria-current={active ? "page" : undefined} aria-controls={`settings-content-${section}`} onClick={() => onClick(section)}>
      <Icon name={icon} width="18" height="18" strokeWidth={2} />
      <span>{label}</span>
    </button>
  );
}

function SettingsPlaceholder({ title }: { title: string }) {
  const t = useI18n();
  return (
    <section className="settings-section settings-placeholder" aria-labelledby={`settings-${title.toLowerCase()}-title`}>
      <header className="settings-section-header">
        <h1 id={`settings-${title.toLowerCase()}-title`}>{t(title)}</h1>
      </header>
    </section>
  );
}
