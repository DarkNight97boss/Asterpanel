"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { ActionState } from "@/components/action-form";
import { getDb, schema } from "@/db";
import { requireAccount } from "@/lib/account";
import { audit } from "@/lib/audit";
import { cleanDnsRecord, createZone, PlatformError, syncDns, touchZone } from "@/platform/engine";

const fail = (err: unknown): ActionState => {
  if (err instanceof PlatformError) return { error: err.message };
  throw err;
};

/** The zone, only if it belongs to the active account. */
async function ownZone(zoneId: unknown) {
  const { user, account } = await requireAccount("hosting");
  if (account.only) throw new PlatformError("Your access is limited to specific services");
  const db = await getDb();
  const [zone] = await db.select().from(schema.dnsZones).where(and(eq(schema.dnsZones.id, z.string().uuid().parse(zoneId)), eq(schema.dnsZones.companyId, account.id)));
  if (!zone) throw new PlatformError("Domain not found");
  return { user, zone, db };
}

export async function addZone(_: ActionState, form: FormData): Promise<ActionState> {
  const { user, account } = await requireAccount("hosting");
  if (account.only) return { error: "Your access is limited to specific services" };
  let id: string;
  try {
    id = await createZone(account.ownerUserId, String(form.get("domain") ?? ""), user.id, account.id);
  } catch (err) {
    return fail(err);
  }
  redirect(`/client/dns/${id}`);
}

export async function addRecord(_: ActionState, form: FormData): Promise<ActionState> {
  try {
    const { user, zone, db } = await ownZone(form.get("zoneId"));
    const record = cleanDnsRecord({ name: String(form.get("name") ?? ""), type: String(form.get("type") ?? ""), value: String(form.get("value") ?? ""), ttl: Number(form.get("ttl")), priority: Number(form.get("priority")) });
    const existing = await db.select().from(schema.dnsRecords).where(and(eq(schema.dnsRecords.zoneId, zone.id), eq(schema.dnsRecords.name, record.name)));
    // RFC 1034: a CNAME cannot share its name with anything else.
    if (existing.some((r) => (r.type === "CNAME") !== (record.type === "CNAME")) || (record.type === "CNAME" && existing.length)) {
      return { error: "A CNAME cannot coexist with other records of the same name" };
    }
    if (existing.some((r) => r.type === record.type && r.value === record.value)) return { error: "This record already exists" };
    await db.insert(schema.dnsRecords).values({ zoneId: zone.id, ...record });
    await audit(user.id, "dns.record_added", "dns_zone", zone.id, record);
    await touchZone(zone.id);
    revalidatePath(`/client/dns/${zone.id}`);
  } catch (err) {
    return fail(err);
  }
}

export async function deleteRecord(form: FormData) {
  const { user, zone, db } = await ownZone(form.get("zoneId"));
  const [gone] = await db.delete(schema.dnsRecords).where(and(eq(schema.dnsRecords.id, z.string().uuid().parse(form.get("recordId"))), eq(schema.dnsRecords.zoneId, zone.id))).returning();
  if (gone) {
    await audit(user.id, "dns.record_deleted", "dns_zone", zone.id, { name: gone.name, type: gone.type });
    await touchZone(zone.id);
  }
  revalidatePath(`/client/dns/${zone.id}`);
}

export async function deleteZone(_: ActionState, form: FormData): Promise<ActionState> {
  try {
    const { user, zone, db } = await ownZone(form.get("zoneId"));
    if (String(form.get("confirm") ?? "").trim().toLowerCase() !== zone.name) return { error: "Type the exact name to confirm" };
    await db.delete(schema.dnsZones).where(eq(schema.dnsZones.id, zone.id));
    await audit(user.id, "dns.zone_deleted", "dns_zone", zone.id, { name: zone.name });
    await syncDns();
  } catch (err) {
    return fail(err);
  }
  redirect("/client/dns");
}
