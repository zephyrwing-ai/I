import fallbackLangData from "./locales/en.json";
import type { NestedKeyOf } from "./utility-types";

export interface Language {
  code: string;
  label: string;
  rtl?: boolean;
}

export type TranslationKeys = NestedKeyOf<typeof fallbackLangData>;

export const defaultLang = { code: "en", label: "English" };

export const languages: Language[] = [defaultLang];

/** Existing host language values resolve to the product's English UI. */
export const setLanguage = async (_lang: Language) => {
  document.documentElement.dir = "ltr";
  document.documentElement.lang = defaultLang.code;
};

export const getLanguage = (): Language => defaultLang;

const findPartsForData = (data: any, parts: string[]) => {
  for (let index = 0; index < parts.length; ++index) {
    const part = parts[index];
    if (data[part] === undefined) {
      return undefined;
    }
    data = data[part];
  }
  if (typeof data !== "string") {
    return undefined;
  }
  return data;
};

export const t = (
  path: NestedKeyOf<typeof fallbackLangData>,
  replacement?: { [key: string]: string | number } | null,
  fallback?: string,
) => {
  const parts = path.split(".");
  let translation = findPartsForData(fallbackLangData, parts) || fallback;
  if (translation === undefined) {
    const errorMessage = `Can't find translation for ${path}`;
    // in production, don't blow up the app on a missing translation key
    if (import.meta.env.PROD) {
      console.warn(errorMessage);
      return "";
    }
    throw new Error(errorMessage);
  }

  if (replacement) {
    for (const key in replacement) {
      translation = translation.replace(`{{${key}}}`, String(replacement[key]));
    }
  }
  return translation;
};

export const useI18n = () => ({ t, langCode: defaultLang.code });
