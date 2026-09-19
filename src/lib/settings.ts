import "server-only";
import { cache } from "react";
import { z } from "zod";
import { getDb, schema } from "@/db";
import { decryptJson, encryptJson } from "./crypto";

/**
 * Settings are grouped documents in the `settings` table. Each group has a
 * zod schema with defaults, so reading a group always yields a complete,
 * valid object even on a fresh install or after an upgrade adds fields.
 */

const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/);

export const settingsSchemas = {
  general: z.object({
    installed: z.boolean().default(false),
    siteName: z.string().default("AsterPanel"),
    tagline: z.string().default("Hosting made simple"),
    locale: z.enum(["en", "it"]).default("en"),
    supportEmail: z.string().default(""),
    companyName: z.string().default(""),
    companyAddress: z.string().default(""),
    companyVatId: z.string().default(""),
    allowRegistration: z.boolean().default(true),
    /** Public origin used for links in emails (no request to read it from). */
    siteUrl: z.string().default(""),
  }),
  theme: z.object({
    logoUrl: z.string().default(""),
    primary: hex.default("#1c1819"),
    accent: hex.default("#ff6728"),
    mode: z.enum(["light", "dark", "auto"]).default("light"),
    radius: z.enum(["none", "sm", "md", "lg", "full"]).default("md"),
    font: z.enum(["editorial", "geist", "system", "serif", "mono"]).default("editorial"),
    /** Thin strip above the site header, e.g. a promotion. Empty = hidden. */
    announcement: z.string().max(200).default(""),
    announcementHref: z.string().max(300).default(""),
    footerText: z.string().default(""),
    customCss: z.string().max(20_000).default(""),
  }),
  billing: z.object({
    currency: z.string().length(3).default("EUR"),
    /** Basis points: 2200 = 22%. */
    taxRate: z.number().int().min(0).max(10_000).default(0),
    taxName: z.string().default("VAT"),
    invoiceDaysBeforeDue: z.number().int().min(0).max(60).default(14),
    suspendDaysAfterDue: z.number().int().min(0).max(90).default(5),
    terminateDaysAfterDue: z.number().int().min(0).max(365).default(30),
    /** Days after the due date on which an overdue reminder is emailed. */
    overdueReminderDays: z.array(z.number().int().min(1).max(365)).max(10).default([3, 7, 14]),
    invoicePrefix: z.string().max(10).default("INV-"),
    bankTransferInstructions: z.string().default(""),
  }),
  /** Encrypted at rest: holds gateway API keys. */
  gateways: z.object({
    bankTransfer: z.object({ enabled: z.boolean().default(true) }).default({ enabled: true }),
    stripe: z
      .object({
        enabled: z.boolean().default(false),
        secretKey: z.string().default(""),
        webhookSecret: z.string().default(""),
        /** Keep the card after a payment and charge renewals on it automatically. */
        saveCards: z.boolean().default(true),
      })
      .default({ enabled: false, secretKey: "", webhookSecret: "", saveCards: true }),
    paypal: z
      .object({
        enabled: z.boolean().default(false),
        clientId: z.string().default(""),
        secret: z.string().default(""),
        /** From the PayPal developer dashboard; needed to verify webhook calls. */
        webhookId: z.string().default(""),
        sandbox: z.boolean().default(false),
      })
      .default({ enabled: false, clientId: "", secret: "", webhookId: "", sandbox: false }),
  }),
  /** Encrypted at rest: holds the SMTP password. */
  mail: z.object({
    enabled: z.boolean().default(false),
    host: z.string().default(""),
    port: z.number().int().min(1).max(65535).default(587),
    security: z.enum(["starttls", "ssl", "none"]).default("starttls"),
    username: z.string().default(""),
    password: z.string().default(""),
    fromName: z.string().default(""),
    fromEmail: z.string().default(""),
    /** Where staff notifications go; falls back to the support email. */
    staffEmail: z.string().default(""),
  }),
  dns: z.object({
    /** Hostnames customers set at their registrar, e.g. ns1.example.com. They must resolve to your nodes. */
    nameservers: z.array(z.string()).max(8).default([]),
    hostmaster: z.string().default(""),
  }),
  /** Italian electronic invoicing (FatturaPA): the seller block of the XML. */
  einvoice: z.object({
    enabled: z.boolean().default(false),
    name: z.string().default(""),
    vatCountry: z.string().default("IT"),
    vatNumber: z.string().default(""),
    fiscalCode: z.string().default(""),
    /** RF01 ordinary, RF19 flat-rate (forfettario)… */
    regime: z.string().default("RF01"),
    address: z.string().default(""),
    zip: z.string().default(""),
    city: z.string().default(""),
    province: z.string().default(""),
    /** Reason for 0% VAT lines, e.g. N2.2 for flat-rate sellers. */
    zeroVatNature: z.string().default("N2.2"),
    zeroVatNote: z.string().default(""),
    iban: z.string().default(""),
  }),
  /** Encrypted: which SDI intermediary sends the electronic invoices, and its credentials. */
  sdi: z.object({
    provider: z.string().default(""),
    accounts: z.record(z.string(), z.record(z.string(), z.string())).default({}),
    /** `paid`: send as soon as an invoice is paid. `manual`: staff presses the button. */
    autoSend: z.enum(["manual", "paid"]).default("manual"),
  }),
  registrars: z.object({
    /** Credentials per registrar module id. */
    accounts: z.record(z.string(), z.record(z.string(), z.string())).default({}),
    /** Name servers given to new registrations. */
    nameservers: z.array(z.string()).default([]),
  }),
  backups: z.object({
    /** Scheduled daily backups kept per service. */
    keepScheduled: z.number().int().min(1).max(90).default(14),
    offsiteEnabled: z.boolean().default(false),
    endpoint: z.string().default(""),
    region: z.string().default(""),
    bucket: z.string().default(""),
    prefix: z.string().default("aster-backups"),
    accessKey: z.string().default(""),
    secretKey: z.string().default(""),
    keepLocal: z.boolean().default(true),
  }),
  /** Encrypted at rest: holds the Ed25519 key that signs agent jobs. */
  platform: z.object({
    signingPrivateKey: z.string().default(""),
    signingPublicKey: z.string().default(""),
  }),
} as const;

const ENCRYPTED: ReadonlySet<SettingsGroup> = new Set(["gateways", "mail", "platform", "backups", "registrars", "sdi"]);

export type SettingsGroup = keyof typeof settingsSchemas;
export type Settings<G extends SettingsGroup> = z.infer<(typeof settingsSchemas)[G]>;

const loadAll = cache(async () => {
  const db = await getDb();
  const rows = await db.select().from(schema.settings);
  return new Map(rows.map((r) => [r.key, r.value]));
});

export async function getSettings<G extends SettingsGroup>(group: G): Promise<Settings<G>> {
  const raw = (await loadAll()).get(group);
  const value = ENCRYPTED.has(group) && typeof raw === "string" ? decryptJson(raw, {}) : (raw ?? {});
  const parsed = settingsSchemas[group].safeParse(value);
  return (parsed.success ? parsed.data : settingsSchemas[group].parse({})) as Settings<G>;
}

export async function updateSettings<G extends SettingsGroup>(
  group: G,
  patch: Partial<Settings<G>>,
): Promise<Settings<G>> {
  const current = await getSettings(group);
  const next = settingsSchemas[group].parse({ ...current, ...patch }) as Settings<G>;
  const value = ENCRYPTED.has(group) ? encryptJson(next) : next;
  const db = await getDb();
  await db
    .insert(schema.settings)
    .values({ key: group, value })
    .onConflictDoUpdate({ target: schema.settings.key, set: { value, updatedAt: new Date() } });
  return next;
}
