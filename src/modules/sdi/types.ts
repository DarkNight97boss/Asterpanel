/**
 * SDI intermediary contract. An intermediary takes the FatturaPA XML, signs and
 * forwards it to the Sistema di Interscambio, and later tells what happened.
 * To add one: implement this interface and register it in `./index.ts`.
 */

export type SdiField = { name: string; label: string; type: "text" | "password"; help?: string };
export type SdiCredentials = Record<string, string> & { sandbox?: string };
export type Http = typeof fetch;

/** `sent`: accepted by the intermediary, outcome pending. The others are final, except `not_delivered` (the customer can still find it in their tax drawer). */
export type SdiStatus = "sent" | "delivered" | "not_delivered" | "rejected";

export type SdiDocument = {
  filename: string;
  xml: string;
  /** Structured copy of the same invoice, for intermediaries that build the XML themselves. */
  data: { number: string; date: string; dueDate: string; isCreditNote: boolean; currency: string; taxRatePercent: number; subtotal: number; tax: number; total: number; lines: { description: string; amount: number }[]; buyer: { name: string; vatNumber: string; taxCode: string; address: string; zip: string; city: string; province: string; country: string; sdiCode: string; pec: string } };
};

export class SdiError extends Error {}

export interface SdiProvider {
  id: string;
  name: string;
  website: string;
  fields: SdiField[];
  /** Hands the invoice over. Returns the intermediary's id for it. */
  send(c: SdiCredentials, doc: SdiDocument, http: Http): Promise<{ externalId: string }>;
  status(c: SdiCredentials, externalId: string, http: Http): Promise<{ status: SdiStatus; message: string }>;
}

/** Intermediaries name SDI outcomes differently; the receipts behind them are the same five. */
export function normalizeSdiStatus(raw: string): SdiStatus {
  const s = raw.toLowerCase().replace(/[\s_-]+/g, "");
  if (/(^ns$|scart|reject|notificascarto|invalid|error)/.test(s)) return "rejected";
  if (/(^mc$|mancataconsegna|notdelivered|nonconsegn|impossibilit|undeliver)/.test(s)) return "not_delivered";
  if (/(^rc$|consegnat|delivered|accepted|accettat|^ne$|^dt$|decorrenza)/.test(s)) return "delivered";
  return "sent";
}

export async function readJson(res: Response): Promise<Record<string, unknown>> {
  return (await res.json().catch(() => ({}))) as Record<string, unknown>;
}

/** First human-readable error in the shapes these APIs use. */
export function apiMessage(json: Record<string, unknown>, fallback: string): string {
  const pick = (v: unknown): string => (typeof v === "string" ? v : Array.isArray(v) ? pick(v[0]) : v && typeof v === "object" ? pick(Object.values(v)[0]) : "");
  return (pick(json.message) || pick(json.error) || pick(json.errorDescription) || pick(json.detail) || pick(json.errors) || pick(json.title) || fallback).slice(0, 300);
}
