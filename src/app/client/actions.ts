"use server";

import { invoiceLabel } from "@/lib/format";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { ActionState } from "@/components/action-form";
import { getDb, schema } from "@/db";
import { audit } from "@/lib/audit";
import { requireAccount } from "@/lib/account";
import { createSession, destroyAllSessions, requireUser, revokeSession } from "@/lib/auth";
import { hashPassword, verifyPassword } from "@/lib/crypto";
import { notify } from "@/lib/notify";
import { getSettings } from "@/lib/settings";
import { beginEnrolment, confirmEnrolment, disableTotp, verifySecondFactor } from "@/lib/totp";
import { baseUrl } from "@/lib/url";
import { enabledGateways } from "@/modules/gateways";

// Every action re-checks ownership: ids come from the browser.

export async function payInvoice(_: ActionState, form: FormData): Promise<ActionState> {
  const { user: me, account: user } = await requireAccount("billing");
  const db = await getDb();
  const invoice = await db.query.invoices.findFirst({
    where: and(eq(schema.invoices.id, String(form.get("invoiceId"))), eq(schema.invoices.companyId, user.id)),
  });
  if (!invoice || invoice.status !== "unpaid") return { error: "This invoice cannot be paid" };

  const gateway = (await enabledGateways()).find((g) => g.id === form.get("gateway"));
  if (!gateway) return { error: "Payment method not available" };

  const billing = await getSettings("billing");
  let url: string;
  try {
    const result = await gateway.start({
      invoice,
      email: me.email,
      returnUrl: `${await baseUrl()}/client/invoices/${invoice.id}`,
      label: invoiceLabel(billing.invoicePrefix, invoice),
    });
    if (result.kind !== "redirect") return { ok: result.text };
    url = result.url;
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Payment failed" };
  }
  redirect(url);
}

export async function openTicket(_: ActionState, form: FormData): Promise<ActionState> {
  const { user, account } = await requireAccount("support");
  const parsed = z
    .object({
      subject: z.string().trim().min(3, "Subject is too short").max(200),
      department: z.enum(["support", "billing", "sales"]),
      priority: z.enum(["low", "medium", "high"]),
      body: z.string().trim().min(10, "Please describe your request").max(20_000),
    })
    .safeParse(Object.fromEntries(form));
  if (!parsed.success) return { error: parsed.error.issues[0].message };

  const db = await getDb();
  const { body, ...ticket } = parsed.data;
  const id = await db.transaction(async (tx) => {
    const [row] = await tx.insert(schema.tickets).values({ ...ticket, clientId: account.ownerUserId, companyId: account.id }).returning();
    await tx.insert(schema.ticketMessages).values({ ticketId: row.id, authorId: user.id, body });
    return row.id;
  });
  notify.ticketOpened(id, body);
  redirect(`/client/tickets/${id}`);
}

export async function replyTicket(_: ActionState, form: FormData): Promise<ActionState> {
  const { user, account } = await requireAccount("support");
  const body = String(form.get("body") ?? "").trim();
  if (body.length < 2 || body.length > 20_000) return { error: "Message is empty" };

  const db = await getDb();
  const ticket = await db.query.tickets.findFirst({
    where: and(eq(schema.tickets.id, String(form.get("ticketId"))), eq(schema.tickets.companyId, account.id)),
  });
  if (!ticket) return { error: "Ticket not found" };

  await db.insert(schema.ticketMessages).values({ ticketId: ticket.id, authorId: user.id, body });
  await db.update(schema.tickets).set({ status: "customer_reply", lastReplyAt: new Date() }).where(eq(schema.tickets.id, ticket.id));
  notify.ticketClientReply(ticket.id, body);
  revalidatePath(`/client/tickets/${ticket.id}`);
}

export async function closeTicket(form: FormData) {
  const { account: user } = await requireAccount("support");
  const db = await getDb();
  await db
    .update(schema.tickets)
    .set({ status: "closed" })
    .where(and(eq(schema.tickets.id, String(form.get("ticketId"))), eq(schema.tickets.companyId, user.id)));
  revalidatePath("/client/tickets");
}

export async function updateProfile(_: ActionState, form: FormData): Promise<ActionState> {
  const user = await requireUser();
  const text = (max: number) => z.string().trim().max(max).default("");
  const parsed = z
    .object({
      firstName: z.string().trim().min(1, "First name is required").max(100),
      lastName: z.string().trim().min(1, "Last name is required").max(100),
      company: text(150),
      vatId: text(50),
      phone: text(50),
      address: text(200),
      city: text(100),
      zip: text(20),
      state: text(100),
      country: text(100),
    })
    .safeParse(Object.fromEntries(form));
  if (!parsed.success) return { error: parsed.error.issues[0].message };

  const db = await getDb();
  await db.update(schema.users).set(parsed.data).where(eq(schema.users.id, user.id));
  revalidatePath("/client/profile");
  return { ok: "Saved" };
}

export async function changePassword(_: ActionState, form: FormData): Promise<ActionState> {
  const user = await requireUser();
  const next = String(form.get("newPassword") ?? "");
  if (next.length < 10 || next.length > 200) return { error: "Password must be at least 10 characters" };

  const db = await getDb();
  const row = await db.query.users.findFirst({ where: eq(schema.users.id, user.id) });
  if (!row || !(await verifyPassword(String(form.get("currentPassword") ?? ""), row.passwordHash))) {
    return { error: "Current password is incorrect" };
  }
  await db.update(schema.users).set({ passwordHash: await hashPassword(next) }).where(eq(schema.users.id, user.id));
  // Sign out every other device, keep this one.
  await destroyAllSessions(user.id);
  await createSession(user.id);
  await audit(user.id, "auth.password.changed", "user", user.id);
  notify.passwordChanged(user.id);
  return { ok: "Password updated" };
}

// ─── Two-factor authentication ───────────────────────────────────────────────

export async function signOutSession(form: FormData) {
  const user = await requireUser();
  await revokeSession(user.id, String(form.get("handle") ?? ""));
  await audit(user.id, "session.revoked", "user", user.id);
  revalidatePath("/client/profile");
}

export async function startTwoFactor() {
  const user = await requireUser();
  await beginEnrolment(user.id);
  revalidatePath("/client/profile");
}

export async function confirmTwoFactor(_: ActionState, form: FormData): Promise<ActionState> {
  const user = await requireUser();
  const codes = await confirmEnrolment(user.id, String(form.get("code") ?? ""));
  if (!codes) return { error: "That code is not valid" };
  await audit(user.id, "auth.2fa.enabled", "user", user.id);
  revalidatePath("/client/profile");
  return { ok: `Two-factor authentication is on. Save these recovery codes now — each works once and they are not shown again:\n\n${codes.join("\n")}` };
}

export async function disableTwoFactor(_: ActionState, form: FormData): Promise<ActionState> {
  const user = await requireUser();
  if (!(await verifySecondFactor(user.id, String(form.get("code") ?? "")))) return { error: "That code is not valid" };
  await disableTotp(user.id);
  await audit(user.id, "auth.2fa.disabled", "user", user.id);
  revalidatePath("/client/profile");
  return { ok: "Two-factor authentication is off" };
}
