import "server-only";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { guessCountry } from "./countries";
import { splitVat } from "./fatturapa";
import { getSettings } from "./settings";

/** VAT rules that depend on who is buying: VIES checks and the EU reverse charge. */

export const EU = new Set("AT BE BG HR CY CZ DK EE FI FR DE GR HU IE IT LV LT LU MT NL PL PT RO SK SI ES SE".split(" "));
export const REVERSE_CHARGE_NOTE = "Reverse charge — VAT to be accounted for by the recipient (art. 196 Directive 2006/112/EC; art. 7-ter DPR 633/72)";

let http: typeof fetch = (...args) => fetch(...args);
export const setViesHttpForTests = (fake: typeof fetch) => void (http = fake);

/** Asks VIES whether a VAT number exists. `null` = the service could not answer (it often cannot): not the same as invalid. */
export async function checkVies(vatId: string, fallbackCountry: string): Promise<{ valid: boolean; name: string } | null> {
  const vat = splitVat(vatId, fallbackCountry);
  // Greece is EL in VIES.
  const cc = vat?.country === "GR" ? "EL" : vat?.country;
  if (!vat || !cc || !(EU.has(vat.country) || cc === "EL") || !/^[A-Z0-9+*]{2,12}$/.test(vat.code)) return { valid: false, name: "" };
  try {
    const res = await http(`https://ec.europa.eu/taxation_customs/vies/rest-api/ms/${cc}/vat/${vat.code}`, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
    const json = (await res.json()) as { isValid?: boolean; name?: string; userError?: string };
    if (!res.ok || typeof json.isValid !== "boolean" || (json.userError && !["VALID", "INVALID"].includes(json.userError))) return null;
    return { valid: json.isValid, name: json.name && json.name !== "---" ? json.name.slice(0, 200) : "" };
  } catch {
    return null;
  }
}

/** Runs the check for a company and remembers a positive answer. */
export async function validateCompanyVat(companyId: string): Promise<"valid" | "invalid" | "unavailable"> {
  const db = await getDb();
  const [co] = await db.select().from(schema.companies).where(eq(schema.companies.id, companyId));
  if (!co?.vatId) return "invalid";
  const result = await checkVies(co.vatId, guessCountry(co.country, "it") || "IT");
  if (!result) return "unavailable";
  await db.update(schema.companies).set({ vatValidatedAt: result.valid ? new Date() : null, vatValidatedName: result.valid ? result.name : "" }).where(eq(schema.companies.id, co.id));
  return result.valid ? "valid" : "invalid";
}

/**
 * Tax rate and note for an invoice to this company. A business in another EU
 * country with a VIES-confirmed VAT number pays no VAT here (reverse charge);
 * everybody else pays the configured rate.
 */
export async function taxFor(companyId: string | null | undefined): Promise<{ rate: number; note: string }> {
  const [billing, einvoice] = await Promise.all([getSettings("billing"), getSettings("einvoice")]);
  const standard = { rate: billing.taxRate, note: "" };
  if (!companyId || !billing.taxRate) return standard;
  const [co] = await (await getDb()).select().from(schema.companies).where(eq(schema.companies.id, companyId));
  if (!co?.vatValidatedAt || co.orgType !== "company") return standard;
  const country = splitVat(co.vatId, guessCountry(co.country, "it") || "")?.country ?? "";
  const seller = einvoice.vatCountry || "IT";
  return EU.has(country) && country !== seller ? { rate: 0, note: REVERSE_CHARGE_NOTE } : standard;
}
