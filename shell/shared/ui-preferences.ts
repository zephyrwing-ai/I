export type AppearancePreference = "system" | "light" | "dark";
export type InterfaceLanguage = "en" | "zh-CN";

export interface UiPreferences {
  appearance: AppearancePreference;
  language: InterfaceLanguage;
}

export const DEFAULT_UI_PREFERENCES: Readonly<UiPreferences> = Object.freeze({ appearance: "system", language: "en" });

export function normalizeUiPreferences(value: unknown): UiPreferences {
  const record = value && typeof value === "object" ? value as Partial<UiPreferences> : {};
  return {
    appearance: record.appearance === "light" || record.appearance === "dark" ? record.appearance : DEFAULT_UI_PREFERENCES.appearance,
    language: record.language === "zh-CN" ? record.language : DEFAULT_UI_PREFERENCES.language,
  };
}

export function parseUiPreferences(value: string | null): UiPreferences {
  try { return normalizeUiPreferences(JSON.parse(value ?? "null")); }
  catch { return { ...DEFAULT_UI_PREFERENCES }; }
}

export function validateUiPreferencesPatch(value: unknown): Partial<UiPreferences> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid interface preferences.");
  const normalized = normalizeUiPreferences(value);
  for (const key of Object.keys(value)) {
    if ((key !== "appearance" && key !== "language") || (value as Record<string, unknown>)[key] !== normalized[key]) {
      throw new Error(`Invalid interface preference: ${key}.`);
    }
  }
  return value as Partial<UiPreferences>;
}
