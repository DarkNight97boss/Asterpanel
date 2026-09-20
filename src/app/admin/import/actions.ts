"use server";

import { revalidatePath } from "next/cache";
import type { ActionState } from "@/components/action-form";
import { audit } from "@/lib/audit";
import { requireAdmin } from "@/lib/auth";
import { runImport, type ImportBundle } from "@/lib/import";
import { getSettings, updateSettings } from "@/lib/settings";
import { fetchWhmcsBundle, testWhmcs, WhmcsError } from "@/lib/whmcs";

const PATH = "/admin/import";

/** Importing creates customers and billable services: administrators only. */
export async function saveWhmcs(_: ActionState, form: FormData): Promise<ActionState> {
  const admin = await requireAdmin();
  const current = await getSettings("whmcs");
  if (form.has("forget")) {
    await updateSettings("whmcs", { url: "", identifier: "", secret: "" });
    revalidatePath(PATH);
    return { ok: "Forgotten" };
  }
  const access = { url: String(form.get("url") ?? "").trim(), identifier: String(form.get("identifier") ?? "").trim(), secret: String(form.get("secret") ?? "").trim() || current.secret };
  try {
    const total = await testWhmcs(access);
    await updateSettings("whmcs", access);
    await audit(admin.id, "settings.updated", "settings", "whmcs");
    revalidatePath(PATH);
    return { ok: `Connected: ${total} customers` };
  } catch (err) {
    if (err instanceof WhmcsError) return { error: err.message };
    throw err;
  }
}

async function bundleFrom(form: FormData): Promise<ImportBundle> {
  const file = form.get("file");
  if (file && typeof file === "object" && "text" in file && file.size > 0) {
    if (file.size > 25 * 1024 * 1024) throw new WhmcsError("The file is too large");
    const parsed = JSON.parse(await file.text()) as Partial<ImportBundle>;
    const list = (v: unknown) => (Array.isArray(v) ? v : []);
    return { source: String(parsed.source ?? "file"), clients: list(parsed.clients), services: list(parsed.services), domains: list(parsed.domains) };
  }
  const { url, identifier, secret } = await getSettings("whmcs");
  if (!url || !identifier || !secret) throw new WhmcsError("Connect your WHMCS first, or choose a file");
  return fetchWhmcsBundle({ url, identifier, secret });
}

/** `mode=preview` only reports; `mode=apply` writes. Both read the source again, so the report is never stale. */
export async function importNow(_: ActionState, form: FormData): Promise<ActionState> {
  const admin = await requireAdmin();
  const apply = form.get("mode") === "apply";
  if (apply && !form.has("confirm")) return { error: "Tick the box to confirm the import" };
  try {
    const report = await runImport(await bundleFrom(form), apply, admin.id);
    await updateSettings("whmcs", { lastReport: JSON.stringify({ at: new Date().toISOString(), applied: apply, ...report }).slice(0, 200_000) });
  } catch (err) {
    if (err instanceof WhmcsError) return { error: err.message };
    if (err instanceof SyntaxError) return { error: "The file is not valid JSON" };
    throw err;
  }
  revalidatePath(PATH);
  return { ok: apply ? "Imported" : "Preview ready" };
}
