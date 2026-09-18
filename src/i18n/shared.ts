import it from "./locales/it";

export const LOCALES = { en: "English", it: "Italiano" } as const;
export type Locale = keyof typeof LOCALES;
export type T = (source: string, vars?: Record<string, string | number>) => string;

const dictionaries: Record<Locale, Record<string, string>> = { en: {}, it };

export function makeT(locale: Locale): T {
  const dict = dictionaries[locale] ?? {};
  return (source, vars) => {
    const text = dict[source] ?? source;
    return vars ? text.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m)) : text;
  };
}
