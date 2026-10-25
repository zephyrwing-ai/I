import { useEffect, useState } from "react";
import type { AttachmentProcessingSettings, DocumentParserDescriptor } from "../../../../../shell/shared/ipc";
import { useI18n } from "../../../shared/i18n";
import { Icon } from "../../../shared/ui/Icon";
import { Select } from "../../../shared/ui/Select";

interface DocumentProcessingSettingsProps {
  disabled?: boolean;
}

export function DocumentProcessingSettings({ disabled = false }: DocumentProcessingSettingsProps) {
  const t = useI18n();
  const [settings, setSettings] = useState<AttachmentProcessingSettings | null>(null);
  const [busy, setBusy] = useState<"loading" | "saving" | "installing" | null>("loading");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (typeof window === "undefined" || !window.agentAPI?.getAttachmentProcessingSettings) {
      setBusy(null);
      return;
    }
    let current = true;
    void window.agentAPI.getAttachmentProcessingSettings().then(
      (next) => {
        if (!current) return;
        setSettings(next);
        setBusy(null);
      },
      (reason: unknown) => {
        if (!current) return;
        setError(reason instanceof Error ? reason.message : String(reason));
        setBusy(null);
      },
    );
    return () => { current = false; };
  }, []);

  const parsers = settings?.parsers ?? [];
  const available = parsers.filter((parser) => parser.available);
  const docling = parsers.find((parser) => parser.parserId === "docling");
  const selected = parsers.find((parser) => parser.parserId === settings?.documentParserId);

  const save = async (parserId: string): Promise<void> => {
    if (busy || disabled || typeof window === "undefined" || !window.agentAPI?.setDocumentParser) return;
    setBusy("saving");
    setError(null);
    try {
      setSettings(await window.agentAPI.setDocumentParser(parserId));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(null);
    }
  };

  const install = async (parser: DocumentParserDescriptor): Promise<void> => {
    if (busy || disabled || typeof window === "undefined" || !window.agentAPI?.installDocumentParser) return;
    setBusy("installing");
    setError(null);
    try {
      setSettings(await window.agentAPI.installDocumentParser(parser.parserId));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <div className="settings-general-row">
        <dt><span id="settings-document-parser-label">{t("Document parsing")}</span></dt>
        <dd>
          {settings ? (
            <Select
              id="settings-document-parser"
              labelledBy="settings-document-parser-label"
              value={settings.documentParserId}
              disabled={disabled || busy !== null || available.length === 0}
              options={available.map((parser) => ({ value: parser.parserId, label: parserLabel(parser, t) }))}
              onValueChange={(value) => void save(value)}
              displayValue={selected ? parserLabel(selected, t) : t("Built-in")}
            />
          ) : <span>{t("Built-in")}</span>}
        </dd>
      </div>
      {docling && !docling.available && (
        <div className="settings-general-row">
          <dt>{t("Advanced parser")}</dt>
          <dd>
            <button
              type="button"
              className="settings-document-install"
              disabled={disabled || busy !== null || !docling.canInstall}
              aria-busy={busy === "installing" || docling.installing || undefined}
              onClick={() => void install(docling)}
            >
              <Icon name="download" width="15" height="15" />
              <span>{busy === "installing" || docling.installing ? t("Downloading…") : t("Download")}</span>
            </button>
          </dd>
        </div>
      )}
      {error && <div className="settings-general-error" role="alert">{error}</div>}
    </>
  );
}

function parserLabel(
  parser: DocumentParserDescriptor,
  translate: (message: string) => string,
): string {
  return parser.parserId === "lightweight" ? translate("Built-in") : parser.displayName;
}
