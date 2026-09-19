import type { BillingCycle, Pricing } from "@/db/schema";
import { BILLING_CYCLES } from "@/db/schema";

export function formatMoney(cents: number, currency: string, locale = "en"): string {
  return new Intl.NumberFormat(locale, { style: "currency", currency }).format(cents / 100);
}

export function formatDate(date: Date | null | undefined, locale = "en"): string {
  return date ? new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(date) : "—";
}

export function formatDateTime(date: Date | null | undefined, locale = "en"): string {
  return date ? new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(date) : "—";
}

export const CYCLE_MONTHS: Record<BillingCycle, number> = {
  monthly: 1,
  quarterly: 3,
  semiannually: 6,
  annually: 12,
  biennially: 24,
  onetime: 0,
};

export const CYCLE_LABEL: Record<BillingCycle, string> = {
  monthly: "Monthly",
  quarterly: "Quarterly",
  semiannually: "Semi-annually",
  annually: "Annually",
  biennially: "Biennially",
  onetime: "One time",
};

/** Short suffix used next to prices: "/mo", "/yr"… */
export const CYCLE_SUFFIX: Record<BillingCycle, string> = {
  monthly: "/mo",
  quarterly: "/3 mo",
  semiannually: "/6 mo",
  annually: "/yr",
  biennially: "/2 yr",
  onetime: "",
};

export function enabledCycles(pricing: Pricing): BillingCycle[] {
  return BILLING_CYCLES.filter((c) => typeof pricing[c] === "number" && pricing[c]! >= 0);
}

/** The cycle advertised on pricing tables: the cheapest per-month one. */
export function headlineCycle(pricing: Pricing): BillingCycle | null {
  const cycles = enabledCycles(pricing);
  if (!cycles.length) return null;
  return cycles.includes("monthly") ? "monthly" : cycles[0];
}

/** Adds one billing period, clamping month-end dates (Jan 31 → Feb 28). */
export function addCycle(from: Date, cycle: BillingCycle): Date | null {
  const months = CYCLE_MONTHS[cycle];
  if (!months) return null;
  const d = new Date(from);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, lastDay));
  return d;
}

/** "12.50" / "12,50" → 1250. Returns null when the input is not a price. */
export function parseMoney(input: string): number | null {
  const s = input.trim().replace(",", ".");
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  return Math.round(parseFloat(s) * 100);
}

export const centsToInput = (cents: number | undefined) => (cents == null ? "" : (cents / 100).toFixed(2));

export function slugify(input: string): string {
  return input
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

export const DOMAIN_RE = /^(?=.{1,253}$)(?!-)([a-z0-9-]{1,63}(?<!-)\.)+[a-z]{2,63}$/i;

export const displayName = (u: { firstName: string; lastName: string; email: string }) =>
  `${u.firstName} ${u.lastName}`.trim() || u.email;
