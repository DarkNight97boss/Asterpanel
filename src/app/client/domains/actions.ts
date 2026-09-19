"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { ActionState } from "@/components/action-form";
import { getDb, schema } from "@/db";
import { requireAccount } from "@/lib/account";
import { BillingError } from "@/lib/billing";
import { domainAuthCode, DomainError, orderDomain, setDomainLock, setDomainNameservers, setDomainPrivacy, syncDomain, updateDomainContact } from "@/lib/domains";
import { rateLimit } from "@/lib/rate-limit";
import { requestMeta } from "@/lib/request";

const fail = (err: unknown): ActionState => {
  if (err instanceof DomainError || err instanceof BillingError) return { error: err.message };
  throw err;
};

export async function order(_: ActionState, form: FormData): Promise<ActionState> {
  const { account } = await requireAccount("manage");
  if (!rateLimit(`domain-order:${account.id}`, 20, 60 * 60_000)) return { error: "Too many attempts. Try again in a few minutes." };
  const f = Object.fromEntries(form);
  let invoiceId: string;
  try {
    ({ invoiceId } = await orderDomain({
      clientId: account.ownerUserId,
      companyId: account.id,
      domain: String(f.domain ?? ""),
      action: f.action === "transfer" ? "transfer" : "register",
      authCode: String(f.authCode ?? ""),
      years: Number(f.years) || 1,
      contact: f,
      ip: (await requestMeta()).ip,
    }));
  } catch (err) {
    return fail(err);
  }
  redirect(`/client/invoices/${invoiceId}`);
}

/** The domain, only if it belongs to the active company. */
async function mine(form: FormData, permission: "hosting" | "manage") {
  const { user, account } = await requireAccount(permission);
  const id = z.string().uuid().parse(form.get("id"));
  const [d] = await (await getDb()).select({ id: schema.domainNames.id }).from(schema.domainNames).where(and(eq(schema.domainNames.id, id), eq(schema.domainNames.companyId, account.id)));
  if (!d) throw new DomainError("Domain not found");
  return { user, id };
}

export async function saveNameservers(_: ActionState, form: FormData): Promise<ActionState> {
  try {
    const { user, id } = await mine(form, "hosting");
    await setDomainNameservers(id, String(form.get("nameservers") ?? "").split(/[\s,]+/), user.id);
    revalidatePath(`/client/domains/${id}`);
  } catch (err) {
    return fail(err);
  }
  return { ok: "Saved. It can take a few hours before the change is visible everywhere." };
}

export async function saveContact(_: ActionState, form: FormData): Promise<ActionState> {
  try {
    const { user, id } = await mine(form, "manage");
    await updateDomainContact(id, Object.fromEntries(form), user.id);
    revalidatePath(`/client/domains/${id}`);
  } catch (err) {
    return fail(err);
  }
  return { ok: "Saved. The registry may email the old and the new address to confirm the change." };
}

export async function togglePrivacy(_: ActionState, form: FormData): Promise<ActionState> {
  try {
    const { user, id } = await mine(form, "manage");
    await setDomainPrivacy(id, form.get("privacy") === "1", user.id);
    revalidatePath(`/client/domains/${id}`);
  } catch (err) {
    return fail(err);
  }
  return { ok: "Saved" };
}

export async function toggleLock(_: ActionState, form: FormData): Promise<ActionState> {
  try {
    const { user, id } = await mine(form, "manage");
    await setDomainLock(id, form.get("locked") === "1", user.id);
    revalidatePath(`/client/domains/${id}`);
  } catch (err) {
    return fail(err);
  }
  return { ok: "Saved" };
}

export async function revealAuthCode(_: ActionState, form: FormData): Promise<ActionState> {
  try {
    const { user, id } = await mine(form, "manage");
    if (!rateLimit(`authcode:${id}`, 5, 60 * 60_000)) return { error: "Too many attempts. Try again in a few minutes." };
    return { ok: `Transfer code: ${await domainAuthCode(id, user.id)}` };
  } catch (err) {
    return fail(err);
  }
}

export async function refresh(_: ActionState, form: FormData): Promise<ActionState> {
  try {
    const { id } = await mine(form, "hosting");
    await syncDomain(id);
    revalidatePath(`/client/domains/${id}`);
  } catch (err) {
    if (err instanceof DomainError) return { error: err.message };
    return { error: "The registrar could not be reached" };
  }
  return { ok: "Updated" };
}
