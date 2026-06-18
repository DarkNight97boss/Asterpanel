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
  // page titles + descriptions
  "Server nodes": "Nodi server",
  "Web analytics": "Analitiche web",
  "Fleet status at a glance.": "Stato della flotta a colpo d'occhio.",
  "Register hosting nodes and issue one-time agent enrollment tokens.":
    "Registra nodi di hosting ed emetti token di enrollment monouso per l'agent.",
  "Manual and scheduled backups to object storage (S3/B2), encrypted, with one-click restore.":
    "Backup manuali e schedulati su object storage (S3/B2), cifrati, con ripristino in un clic.",
  "Automatic certificates via Let's Encrypt (ACME). Auto-renewed before expiry.":
    "Certificati automatici via Let's Encrypt (ACME). Rinnovati prima della scadenza.",
  "Scheduled commands run in the site's container with resource limits.":
    "Comandi schedulati eseguiti nel container del sito con limiti di risorse.",
  "Provision managed database instances on your nodes (Postgres, MySQL, Redis…).":
    "Provisiona istanze di database gestite sui tuoi nodi (Postgres, MySQL, Redis…).",
  "Per-site runtime and language version (PHP, Node…). Changing it redeploys the container.":
    "Versione runtime e linguaggio per sito (PHP, Node…). Cambiarla ridistribuisce il container.",
  "Per-site traffic from the access log: requests, unique visitors, bandwidth and top pages.":
    "Traffico per sito dal log accessi: richieste, visitatori unici, banda e pagine più viste.",
  "IMAP/SMTP mailboxes with quotas, SPF/DKIM signing and spam filtering.":
    "Caselle IMAP/SMTP con quote, firma SPF/DKIM e filtro antispam.",
  // dashboard hero
  "Welcome back": "Bentornato",
  online: "online",
  active: "attivi",
  OK: "OK",
  "last 5 min": "ultimi 5 min",
  // dashboard launcher tile descriptions
  "Server fleet & agents": "Flotta server e agent",
  "CPU, memory, traffic": "CPU, memoria, traffico",
  "Uptime & service checks": "Uptime e controlli servizi",
  "Live system logs": "Log di sistema in tempo reale",
  "Create & manage sites": "Crea e gestisci siti",
  "Zones, records, DNSSEC": "Zone, record, DNSSEC",
  "Certificates & HTTPS": "Certificati e HTTPS",
  "PHP, Node & app stack": "PHP, Node e stack app",
  "Per-site traffic": "Traffico per sito",
  "Install WordPress & more": "Installa WordPress e altro",
  "Accounts, aliases & filters": "Account, alias e filtri",
  "Browser mail client": "Client mail nel browser",
  "MySQL & PostgreSQL": "MySQL e PostgreSQL",
  "Browse & edit files": "Sfoglia e modifica file",
  "Transfer accounts": "Account di trasferimento",
  "Snapshots & restore": "Snapshot e ripristino",
  "Scheduled tasks": "Attività pianificate",
  "Variables & secrets": "Variabili e segreti",
  "IP rules & bans": "Regole IP e ban",
  "Application firewall": "Firewall applicativo",
  "Security events": "Eventi di sicurezza",
  "Programmatic access": "Accesso programmatico",
  "Sub-accounts & plans": "Sotto-account e piani",
  "Import from cPanel": "Importa da cPanel",
  "White-label the panel": "Personalizza il pannello",
  "Event notifications": "Notifiche eventi",
  "Invoices & usage": "Fatture e utilizzo",
  "Alerts & channels": "Avvisi e canali",
  // in-page sub-tabs
  Domains: "Domini",
  "DNS Records": "Record DNS",
  Redirects: "Redirect",
  "Directory Privacy": "Privacy directory",
  DNSSEC: "DNSSEC",
  "Hotlink Protection": "Protezione hotlink",
  "Dynamic DNS": "DNS dinamico",
  "Web Disk": "Web Disk",
  Instances: "Istanze",
  "SQL Query": "Query SQL",
  "Remote Access": "Accesso remoto",
  Export: "Esporta",
  Forwarders: "Inoltri",
  Autoresponders: "Risponditori",
  Filters: "Filtri",
  "Mailing Lists": "Liste email",
  Calendars: "Calendari",
  Deliverability: "Recapito",
  Spam: "Spam",
  "Run Backup": "Esegui backup",
  Schedules: "Pianificazioni",
  History: "Cronologia",
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
