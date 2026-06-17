"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

export type Locale = "en" | "it";

export const LOCALES: { value: Locale; label: string }[] = [
  { value: "en", label: "EN" },
  { value: "it", label: "IT" },
];

type Dict = Record<string, string>;

// Translations are keyed by the English source string, so a component can call
// t("Sign in") with no separate key table. English is the identity dictionary;
// add a locale here and translate the strings you want localized — anything
// missing falls back to English automatically.
const it: Dict = {
  // sidebar groups
  Infrastructure: "Infrastruttura",
  Sites: "Siti",
  Email: "Email",
  Data: "Dati",
  Automation: "Automazione",
  Config: "Configurazione",
  Security: "Sicurezza",
  Account: "Account",
  // sidebar items
  Overview: "Panoramica",
  Nodes: "Nodi",
  Metrics: "Metriche",
  Health: "Stato",
  Logs: "Log",
  Websites: "Siti web",
  "Domains & DNS": "Domini e DNS",
  "SSL / TLS": "SSL / TLS",
  Runtime: "Runtime",
  Analytics: "Analitiche",
  "One-Click Apps": "App one-click",
  Mailboxes: "Caselle email",
  Webmail: "Webmail",
  Databases: "Database",
  "File Manager": "Gestione file",
  "FTP / SFTP": "FTP / SFTP",
  Backups: "Backup",
  "Cron Jobs": "Cron",
  "Env & Secrets": "Variabili e segreti",
  Firewall: "Firewall",
  WAF: "WAF",
  "Audit Log": "Audit log",
  "API Tokens": "Token API",
  Reseller: "Rivenditore",
  Migrations: "Migrazioni",
  Branding: "Personalizzazione",
  Webhooks: "Webhook",
  Billing: "Fatturazione",
  Notifications: "Notifiche",
  "Sign out": "Esci",
  // login
  "Sign in to your control panel": "Accedi al tuo pannello di controllo",
  "Enter your authenticator code": "Inserisci il codice dell'autenticatore",
  "Sign in": "Accedi",
  "Signing in…": "Accesso in corso…",
  "Sign in with a passkey": "Accedi con una passkey",
  "6-digit code": "Codice a 6 cifre",
  Verify: "Verifica",
  "Verifying…": "Verifica in corso…",
  "Login failed": "Accesso non riuscito",
  "Invalid code": "Codice non valido",
  "Passkey sign-in failed": "Accesso con passkey non riuscito",
};

const DICTS: Record<Locale, Dict> = { en: {}, it };

interface I18nState {
  locale: Locale;
  setLocale: (l: Locale) => void;
  t: (key: string) => string;
}

const Ctx = createContext<I18nState | null>(null);

const STORAGE_KEY = "asterpanel.locale";

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>("en");

  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved === "en" || saved === "it") {
        setLocaleState(saved);
        return;
      }
    } catch {
      /* localStorage unavailable */
    }
    if (typeof navigator !== "undefined" && navigator.language.toLowerCase().startsWith("it")) {
      setLocaleState("it");
    }
  }, []);

  function setLocale(l: Locale) {
    setLocaleState(l);
    try {
      localStorage.setItem(STORAGE_KEY, l);
    } catch {
      /* ignore */
    }
  }

  function t(key: string) {
    return DICTS[locale][key] ?? key;
  }

  return <Ctx.Provider value={{ locale, setLocale, t }}>{children}</Ctx.Provider>;
}

export function useT(): I18nState {
  const ctx = useContext(Ctx);
  if (ctx) return ctx;
  // Outside a provider (e.g. during SSR fallback): identity translation.
  return { locale: "en", setLocale: () => {}, t: (k) => k };
}

export function LanguageSwitcher({ className = "" }: { className?: string }) {
  const { locale, setLocale } = useT();
  return (
    <select
      aria-label="Language"
      value={locale}
      onChange={(e) => setLocale(e.target.value as Locale)}
      className={`rounded-md border border-border bg-transparent px-1.5 py-0.5 text-xs text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${className}`}
    >
      {LOCALES.map((l) => (
        <option key={l.value} value={l.value} className="bg-card">
          {l.label}
        </option>
      ))}
    </select>
  );
}
