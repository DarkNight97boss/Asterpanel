"use client";

import { createContext, useContext, useMemo } from "react";
import { makeT, type Locale, type T } from "./shared";

const LocaleContext = createContext<Locale>("en");

export function I18nProvider({ locale, children }: { locale: Locale; children: React.ReactNode }) {
  return <LocaleContext.Provider value={locale}>{children}</LocaleContext.Provider>;
}

export function useT(): T {
  const locale = useContext(LocaleContext);
  return useMemo(() => makeT(locale), [locale]);
}

export const useLocale = () => useContext(LocaleContext);
