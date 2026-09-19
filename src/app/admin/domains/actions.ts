"use server";

import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { ActionState } from "@/components/action-form";
import { getDb, schema } from "@/db";
import { audit } from "@/lib/audit";
import { requireAdmin, requireArea } from "@/lib/auth";
import { cleanNameservers, DomainError, syncDomain, testRegistrar } from "@/lib/domains";
import { parseMoney } from "@/lib/format";
import { getSettings, updateSettings } from "@/lib/settings";
import { getRegistrar, registrarModules } from "@/modules/registrars";

export async function saveRegistrar(_: ActionState, form: FormData): Promise<ActionState> {
  const admin = await requireAdmin();
  const mod = getRegistrar(String(form.get("registrar")));
  if (!mod) return { error: "Unknown registrar" };
  const current = await getSettings("registrars");
  const previous = current.accounts[mod.id] ?? {};
  const account: Record<string, string> = { sandbox: form.has("sandbox") ? "1" : "" };
  // Secrets left empty keep their saved value: they are never sent back to the browser.
  for (const f of mod.fields) account[f.name] = String(form.get(f.name) ?? "").trim().slice(0, 300) || (f.type === "password" ? (previous[f.name] ?? "") : "");
  await updateSettings("registrars", { ...current, accounts: { ...current.accounts, [mod.id]: account } });
  await audit(admin.id, "settings.updated", "settings", `registrars.${mod.id}`);
  revalidatePath("/admin/settings/registrars");
  return { ok: "Saved" };
}

export async function saveRegistrarNameservers(_: ActionState, form: FormData): Promise<ActionState> {
  const admin = await requireAdmin();
  try {
    const nameservers = cleanNameservers(String(form.get("nameservers") ?? "").split(/[\s,]+/));
    await updateSettings("registrars", { ...(await getSettings("registrars")), nameservers });
  } catch (err) {
    if (err instanceof DomainError) return { error: err.message };
    throw err;
  }
  await audit(admin.id, "settings.updated", "settings", "registrars.nameservers");
  revalidatePath("/admin/settings/registrars");
  return { ok: "Saved" };
}

export async function testRegistrarConnection(_: ActionState, form: FormData): Promise<ActionState> {
  await requireAdmin();
  try {
    return { ok: await testRegistrar(String(form.get("registrar"))) };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "The registrar could not be reached" };
  }
}

export async function saveTld(_: ActionState, form: FormData): Promise<ActionState> {
  const admin = await requireAdmin();
  const f = Object.fromEntries(form);
  const tld = String(f.tld ?? "").trim().toLowerCase().replace(/^\./, "");
  if (!/^[a-z0-9-]{2,24}(\.[a-z0-9-]{2,24})?$/.test(tld)) return { error: "Enter an extension such as com or co.uk" };
  if (!registrarModules.some((m) => m.id === f.registrar)) return { error: "Unknown registrar" };
  const prices = [parseMoney(String(f.registerPrice ?? "")), parseMoney(String(f.renewPrice ?? "")), parseMoney(String(f.transferPrice ?? ""))];
  if (prices.some((p) => p === null)) return { error: "Enter prices such as 12.90" };
  const [registerPrice, renewPrice, transferPrice] = prices as number[];
  const row = { tld, registrar: String(f.registrar), registerPrice, renewPrice, transferPrice, enabled: form.has("enabled"), sort: z.coerce.number().int().min(0).max(9999).catch(0).parse(f.sort) };
  const db = await getDb();
  await db.insert(schema.domainTlds).values(row).onConflictDoUpdate({ target: schema.domainTlds.tld, set: row });
  await audit(admin.id, "tld.saved", "tld", tld, row);
  revalidatePath("/admin/domains");
  return { ok: "Saved" };
}

export async function deleteTld(_: ActionState, form: FormData): Promise<ActionState> {
  const admin = await requireAdmin();
  const id = z.string().uuid().parse(form.get("id"));
  // Existing domains keep renewing at the price frozen on their service.
  await (await getDb()).delete(schema.domainTlds).where(eq(schema.domainTlds.id, id));
  await audit(admin.id, "tld.deleted", "tld", id);
  revalidatePath("/admin/domains");
  return { ok: "Removed" };
}

export async function syncDomainNow(_: ActionState, form: FormData): Promise<ActionState> {
  await requireArea("billing");
  try {
    await syncDomain(z.string().uuid().parse(form.get("id")));
  } catch (err) {
    return { error: err instanceof Error ? err.message : "The registrar could not be reached" };
  }
  revalidatePath("/admin/domains");
  return { ok: "Updated" };
}
