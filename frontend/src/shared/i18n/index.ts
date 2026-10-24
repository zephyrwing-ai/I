import { useCallback } from "react";
import { useUiPreferences, type InterfaceLanguage } from "../preferences/uiPreferences";
import { chinese } from "./locales/zh-CN";

export type TranslationParams = Record<string, string | number>;
export function translate(language: InterfaceLanguage, message: string, params: TranslationParams = {}): string {
  const template = language === "zh-CN" && Object.hasOwn(chinese, message) ? chinese[message]! : message;
  return template.replace(/\{(\w+)\}/g, (match, key: string) => Object.hasOwn(params, key) ? String(params[key]) : match);
}

export function useI18n() {
  const { language } = useUiPreferences();
  return useCallback((message: string, params?: TranslationParams) => translate(language, message, params), [language]);
}
