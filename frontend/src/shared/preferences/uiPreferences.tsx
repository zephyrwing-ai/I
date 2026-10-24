import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";

export type AppearancePreference = "system" | "light" | "dark";
export type InterfaceLanguage = "en" | "zh-CN";
export interface UiPreferences {
  appearance: AppearancePreference;
  language: InterfaceLanguage;
}

export const UI_PREFERENCES_STORAGE_KEY = "workbench.uiPreferences";
const defaults: UiPreferences = { appearance: "system", language: "en" };

export function parseUiPreferences(value: string | null): UiPreferences {
  try {
    const parsed: unknown = JSON.parse(value ?? "null");
    if (!parsed || typeof parsed !== "object") return defaults;
    const { appearance, language } = parsed as Partial<UiPreferences>;
    return {
      appearance: appearance === "light" || appearance === "dark" ? appearance : "system",
      language: language === "zh-CN" ? language : "en",
    };
  } catch {
    return defaults;
  }
}

export function resolveAppearance(appearance: AppearancePreference, systemDark: boolean): "light" | "dark" {
  return appearance === "system" ? (systemDark ? "dark" : "light") : appearance;
}

interface UiPreferencesContextValue extends UiPreferences {
  theme: "light" | "dark";
  setAppearance: (appearance: AppearancePreference) => void;
  setLanguage: (language: InterfaceLanguage) => void;
}

const UiPreferencesContext = createContext<UiPreferencesContextValue>({
  ...defaults, theme: "light", setAppearance: () => undefined, setLanguage: () => undefined,
});

export function UiPreferencesProvider({ children }: { children: ReactNode }) {
  const [preferences, setPreferences] = useState(() => {
    try { return parseUiPreferences(globalThis.localStorage?.getItem(UI_PREFERENCES_STORAGE_KEY) ?? null); }
    catch { return defaults; }
  });
  const [systemDark, setSystemDark] = useState(() => (
    typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches
  ));
  const saved = useRef(preferences);
  const theme = resolveAppearance(preferences.appearance, systemDark);

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

  useEffect(() => {
    if (saved.current === preferences) return;
    try { globalThis.localStorage?.setItem(UI_PREFERENCES_STORAGE_KEY, JSON.stringify(preferences)); }
    catch { /* Live preferences remain usable when local storage is unavailable. */ }
    saved.current = preferences;
  }, [preferences]);

  const setAppearance = useCallback((appearance: AppearancePreference) => {
    setPreferences(current => current.appearance === appearance ? current : { ...current, appearance });
  }, []);
  const setLanguage = useCallback((language: InterfaceLanguage) => {
    setPreferences(current => current.language === language ? current : { ...current, language });
  }, []);
  const value = useMemo(() => ({ ...preferences, theme, setAppearance, setLanguage }), [preferences, theme, setAppearance, setLanguage]);
  return <UiPreferencesContext.Provider value={value}>{children}</UiPreferencesContext.Provider>;
}

export function useUiPreferences(): UiPreferencesContextValue {
  return useContext(UiPreferencesContext);
}
