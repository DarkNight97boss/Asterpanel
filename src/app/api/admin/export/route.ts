import { getUser } from "@/lib/auth";
import { invoiceLabel } from "@/lib/format";
import { invoicesCsv } from "@/lib/reports";
import { getSettings } from "@/lib/settings";
import { staffCan } from "@/lib/staff";

export const dynamic = "force-dynamic";

/** GET /api/admin/export?month=2026-09 — the month's documents as CSV, for billing staff. */
export async function GET(request: Request) {
  const user = await getUser();
  if (!user || !staffCan(user, "billing")) return new Response("Not found", { status: 404 });
  const month = new URL(request.url).searchParams.get("month") ?? "";
  const prefix = (await getSettings("billing")).invoicePrefix;
  try {
    const body = await invoicesCsv(month, (inv) => invoiceLabel(prefix, inv));
    // BOM: Excel otherwise reads UTF-8 as Latin-1.
    return new Response(`﻿${body}`, { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="invoices-${month}.csv"`, "Cache-Control": "private, no-store" } });
  } catch {
    return new Response("Invalid month", { status: 400 });
  }
}
