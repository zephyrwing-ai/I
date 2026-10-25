import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { DEFAULT_UI_PREFERENCES, parseUiPreferences, type AppearancePreference, type InterfaceLanguage, type UiPreferences } from "../../../../shell/shared/ui-preferences";
export type { AppearancePreference, InterfaceLanguage } from "../../../../shell/shared/ui-preferences";

const LEGACY_STORAGE_KEY = "workbench.uiPreferences";

export function resolveAppearance(appearance: AppearancePreference, systemDark: boolean): "light" | "dark" {
  return appearance === "system" ? (systemDark ? "dark" : "light") : appearance;
}

interface UiPreferencesContextValue extends UiPreferences {
  theme: "light" | "dark";
  error: string | null;
  setAppearance: (appearance: AppearancePreference) => void;
  setLanguage: (language: InterfaceLanguage) => void;
}

const UiPreferencesContext = createContext<UiPreferencesContextValue>({
  ...DEFAULT_UI_PREFERENCES, theme: "light", error: null, setAppearance: () => undefined, setLanguage: () => undefined,
});

export function UiPreferencesProvider({ children }: { children: ReactNode }) {
  const [preferences, setPreferences] = useState<UiPreferences>({ ...DEFAULT_UI_PREFERENCES });
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [systemDark, setSystemDark] = useState(() => (
    typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches
  ));
  const saveRequest = useRef(0);
  const appliedRequest = useRef(0);
  const theme = resolveAppearance(preferences.appearance, systemDark);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        let legacy: UiPreferences | undefined;
        try {
          const raw = globalThis.localStorage?.getItem(LEGACY_STORAGE_KEY);
          if (raw != null) legacy = parseUiPreferences(raw);
        } catch { /* Main preferences also work when browser storage is unavailable. */ }
        const restored = await window.agentAPI.getUiPreferences(legacy);
        if (active) setPreferences(restored);
        try { globalThis.localStorage?.removeItem(LEGACY_STORAGE_KEY); } catch { /* The file is already authoritative. */ }
      } catch {
        if (active) setError("Unable to load interface preferences.");
      } finally {
        if (active) setReady(true);
      }
    })();
    return () => { active = false; };
  }, []);

  useLayoutEffect(() => {
    if (preferences.appearance !== "system") return;
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    const update = () => setSystemDark(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, [preferences.appearance]);

  useLayoutEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.lang = preferences.language;
  }, [preferences.language, theme]);

  const update = useCallback(async (patch: Partial<UiPreferences>) => {
    const request = ++saveRequest.current;
    setError(null);
    try {
      const saved = await window.agentAPI.updateUiPreferences(patch);
      if (request > appliedRequest.current) {
        appliedRequest.current = request;
        setPreferences(saved);
      }
    } catch {
      if (request === saveRequest.current) setError("Unable to save interface preferences.");
    }
  }, []);

  const setAppearance = useCallback((appearance: AppearancePreference) => {
    void update({ appearance });
  }, [update]);
  const setLanguage = useCallback((language: InterfaceLanguage) => {
    void update({ language });
  }, [update]);
  const value = useMemo(() => ({ ...preferences, theme, error, setAppearance, setLanguage }), [preferences, theme, error, setAppearance, setLanguage]);
  return <UiPreferencesContext.Provider value={value}>{ready ? children : null}</UiPreferencesContext.Provider>;
}

export function useUiPreferences(): UiPreferencesContextValue {
  return useContext(UiPreferencesContext);
}
