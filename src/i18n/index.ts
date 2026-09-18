import "server-only";
import { cache } from "react";
import { getSettings } from "@/lib/settings";
import { makeT, type Locale } from "./shared";

/**
 * gettext-style i18n: the English source string is the key, other locales
 * live in `./locales/<code>.ts`. A missing translation falls back to English,
 * so adding a language never blocks shipping a feature.
 */
export const getLocale = cache(async (): Promise<Locale> => (await getSettings("general")).locale);

export const getT = cache(async () => makeT(await getLocale()));
