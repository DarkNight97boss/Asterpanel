import "server-only";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { makeT, type T } from "@/i18n/shared";
import { CYCLE_LABEL, displayName, formatDate, formatMoney, invoiceLabel } from "./format";
import { renderInvoicePdf } from "./invoice-pdf";
import { loadInvoice } from "./invoices";
import { renderMail, type MailContent } from "./mail/layout";
import { composeTemplate, templateDef } from "./mail/templates";
import { mailConfigured, sendMail, type Attachment } from "./mail/transport";
import { getSettings, type Settings } from "./settings";

/**
 * Transactional notifications.
 *
 * Every `notify.*` call is fire-and-forget: it returns immediately and can
 * never throw into the caller, so a slow or broken SMTP server cannot delay an
 * order or fail a payment webhook. Work that must not end before the mail is
 * out (cron endpoint, tests) awaits `flushNotifications()`.
 *
 * Wording lives in `mail/templates.ts` and can be overridden by admins; this
 * file decides who gets what, and the structural parts of each message.
 */

const pending = new Set<Promise<unknown>>();

function dispatch(job: () => Promise<unknown>) {
  const p = job()
    .catch((err) => console.error("[notify]", err))
    .finally(() => pending.delete(p));
  pending.add(p);
}

export async function flushNotifications() {
  while (pending.size) await Promise.allSettled([...pending]);
}

type SendResult = { ok: boolean; error?: string };
type Structure = Pick<MailContent, "greeting" | "details" | "quote" | "cta"> & { extraParagraphs?: string[] };

type Ctx = {
  t: T;
  locale: Settings<"general">["locale"];
  general: Settings<"general">;
  billing: Settings<"billing">;
  origin: string;
  /** Composes template `id` and sends it. `logAs` changes only the log label. */
  send: (args: {
    id: string;
    to: string;
    userId?: string | null;
    vars: Record<string, string>;
    structure?: Structure;
    attachments?: Attachment[];
    logAs?: string;
  }) => Promise<SendResult>;
};

export const mailOrigin = (general: Settings<"general">) => (process.env.APP_URL || general.siteUrl).replace(/\/+$/, "");

/** Loads branding once per notification; resolves to null when mail is off. */
async function context(): Promise<Ctx | null> {
  const [mail, general, billing, theme] = await Promise.all([
    getSettings("mail"),
    getSettings("general"),
    getSettings("billing"),
    getSettings("theme"),
  ]);
  if (!mailConfigured(mail)) return null;
  const origin = mailOrigin(general);
  const t = makeT(general.locale);

  return {
    t,
    locale: general.locale,
    general,
    billing,
    origin,
    async send({ id, to, userId, vars, structure = {}, attachments, logAs }) {
      const def = templateDef(id);
      if (!def) throw new Error(`Unknown email template: ${id}`);
      const db = await getDb();
      const override = await db.query.emailTemplates.findFirst({ where: eq(schema.emailTemplates.id, id) });
      const wording = composeTemplate(def, override, { site: general.siteName, ...vars }, t);
      if (!wording) return { ok: false, error: "This email template is disabled" };

      const { extraParagraphs = [], ...rest } = structure;
      const content: MailContent = { ...wording, ...rest, paragraphs: [...wording.paragraphs, ...extraParagraphs] };
      return sendMail({ to, userId, template: logAs ?? id, subject: content.subject, attachments, ...renderMail(content, { general, theme, origin }) });
    },
  };
}

const firstName = (u: { firstName: string; lastName: string; email: string }) => u.firstName || displayName(u);

async function loadUser(id: string) {
  const db = await getDb();
  return db.query.users.findFirst({ where: eq(schema.users.id, id), columns: { passwordHash: false } });
}

async function accountMail(userId: string, id: string, vars: Record<string, string> = {}, cta?: (ctx: Ctx) => MailContent["cta"]) {
  const ctx = await context();
  const user = ctx && (await loadUser(userId));
  if (!ctx || !user) return { ok: false, error: "Email is not configured" };
  const name = firstName(user);
  return ctx.send({
    id,
    to: user.email,
    userId,
    vars: { name, ...vars },
    structure: { greeting: ctx.t("Hi {name},", { name }), cta: cta?.(ctx) },
  });
}

async function invoiceMail(invoiceId: string, id: "invoice.created" | "invoice.paid" | "invoice.reminder", logAs?: string): Promise<SendResult> {
  const ctx = await context();
  const invoice = ctx && (await loadInvoice(invoiceId));
  if (!ctx || !invoice) return { ok: false, error: "Email is not configured" };
  const { t, locale, billing, origin } = ctx;
  const number = invoiceLabel(billing.invoicePrefix, invoice);
  const paid = invoice.status === "paid";
  const money = (cents: number) => formatMoney(cents, invoice.currency, locale);
  const pdf = await renderInvoicePdf(invoice);
  const name = firstName(invoice.client);

  return ctx.send({
    id,
    logAs,
    to: invoice.client.email,
    userId: invoice.clientId,
    attachments: [{ filename: pdf.filename, content: Buffer.from(pdf.bytes), contentType: "application/pdf" }],
    vars: {
      name,
      number,
      total: money(invoice.total),
      date: formatDate(invoice.dueDate, locale),
      days: String(Math.max(0, Math.floor((Date.now() - invoice.dueDate.getTime()) / 86_400_000))),
    },
    structure: {
      greeting: t("Hi {name},", { name }),
      details: [
        [t("Invoice"), number],
        ...invoice.items.map((i): [string, string] => [i.description, money(i.amount)]),
        [t("Total"), money(invoice.total)],
        paid ? [t("Paid on"), formatDate(invoice.paidAt, locale)] : [t("Due"), formatDate(invoice.dueDate, locale)],
      ],
      cta: { label: paid ? t("View invoice") : t("Pay this invoice"), url: `${origin}/client/invoices/${invoice.id}` },
    },
  });
}

async function serviceMail(serviceId: string, id: string, vars: Record<string, string> = {}, extraParagraphs: string[] = []) {
  const ctx = await context();
  if (!ctx) return;
  const db = await getDb();
  const service = await db.query.services.findFirst({
    where: eq(schema.services.id, serviceId),
    with: { product: true, client: { columns: { passwordHash: false } } },
  });
  if (!service) return;
  const { t, locale, billing, origin } = ctx;
  const name = firstName(service.client);
  const row = (label: string, value: string | null | undefined): [string, string][] => (value ? [[label, value]] : []);

  await ctx.send({
    id,
    to: service.client.email,
    userId: service.clientId,
    vars: { name, service: `${service.product.name}${service.domain ? ` (${service.domain})` : ""}`, ...vars },
    structure: {
      greeting: t("Hi {name},", { name }),
      extraParagraphs,
      details: [
        [t("Service"), service.product.name],
        ...row(t("Domain"), service.domain),
        ...row(t("Username"), service.username),
        [t("Price"), `${formatMoney(service.amount, billing.currency, locale)} · ${t(CYCLE_LABEL[service.billingCycle])}`],
        ...row(t("Next due"), service.nextDueDate && formatDate(service.nextDueDate, locale)),
      ],
      cta: { label: t("Manage service"), url: `${origin}/client/services/${service.id}` },
    },
  });
}

async function ticketMail(ticketId: string, id: "ticket.opened" | "ticket.client_reply" | "ticket.staff_reply", body: string) {
  const ctx = await context();
  if (!ctx) return;
  const db = await getDb();
  const ticket = await db.query.tickets.findFirst({ where: eq(schema.tickets.id, ticketId), with: { client: { columns: { passwordHash: false } } } });
  if (!ticket) return;
  const { t, origin, general } = ctx;
  const toClient = id === "ticket.staff_reply";
  const to = toClient ? ticket.client.email : (await getSettings("mail")).staffEmail || general.supportEmail;
  if (!to) return;
  const name = firstName(ticket.client);

  await ctx.send({
    id,
    to,
    userId: toClient ? ticket.clientId : null,
    vars: { name, number: String(ticket.number), subject: ticket.subject, client: displayName(ticket.client) },
    structure: {
      greeting: toClient ? t("Hi {name},", { name }) : undefined,
      extraParagraphs: toClient ? [] : [`${ticket.department} · ${ticket.priority}`],
      quote: body.length > 2000 ? `${body.slice(0, 2000)}…` : body,
      cta: {
        label: toClient ? t("View and reply") : t("Open ticket"),
        url: `${origin}/${toClient ? "client" : "admin"}/tickets/${ticket.id}`,
      },
    },
  });
}

export const notify = {
  welcome: (userId: string) =>
    dispatch(() => accountMail(userId, "account.welcome", {}, ({ t, origin }) => ({ label: t("Go to the client area"), url: `${origin}/client` }))),
  passwordChanged: (userId: string) =>
    dispatch(() => accountMail(userId, "account.password_changed", {}, ({ t, origin }) => ({ label: t("Reset password"), url: `${origin}/forgot-password` }))),

  invoiceCreated: (invoiceId: string) => dispatch(() => invoiceMail(invoiceId, "invoice.created")),
  invoicePaid: (invoiceId: string) => dispatch(() => invoiceMail(invoiceId, "invoice.paid")),
  invoiceReminder: (invoiceId: string) => dispatch(() => invoiceMail(invoiceId, "invoice.reminder")),

  serviceActivated: (serviceId: string, moduleMessage?: string) =>
    dispatch(async () => serviceMail(serviceId, "service.activated", {}, moduleMessage ? [makeT((await getSettings("general")).locale)(moduleMessage)] : [])),
  serviceSuspended: (serviceId: string, reason: string) =>
    dispatch(async () => serviceMail(serviceId, "service.suspended", { reason: makeT((await getSettings("general")).locale)(reason) })),
  serviceUnsuspended: (serviceId: string) => dispatch(() => serviceMail(serviceId, "service.unsuspended")),
  serviceTerminated: (serviceId: string) => dispatch(() => serviceMail(serviceId, "service.terminated")),

  uptime: (workloadId: string, state: "down" | "up", reason: string) =>
    dispatch(async () => {
      const ctx = await context();
      if (!ctx) return;
      const db = await getDb();
      const w = await db.query.workloads.findFirst({ where: eq(schema.workloads.id, workloadId), with: { client: { columns: { passwordHash: false } }, domains: true } });
      if (!w) return;
      const name = firstName(w.client);
      await ctx.send({
        id: `uptime.${state}`,
        to: w.client.email,
        userId: w.clientId,
        vars: { name, service: `${w.name}${w.domains[0] ? ` (${w.domains[0].hostname})` : ""}`, reason },
        structure: { greeting: ctx.t("Hi {name},", { name }), cta: { label: ctx.t("Open the dashboard"), url: `${ctx.origin}/client/workloads/${w.id}` } },
      });
    }),

  ticketOpened: (ticketId: string, body: string) => dispatch(() => ticketMail(ticketId, "ticket.opened", body)),
  ticketClientReply: (ticketId: string, body: string) => dispatch(() => ticketMail(ticketId, "ticket.client_reply", body)),
  ticketStaffReply: (ticketId: string, body: string) => dispatch(() => ticketMail(ticketId, "ticket.staff_reply", body)),
};

// ─── Awaited variants: the caller needs the outcome ──────────────────────────

/** Admin "Email to client" button: the template follows the invoice status. */
export async function resendInvoice(invoiceId: string): Promise<SendResult> {
  const invoice = await loadInvoice(invoiceId);
  return invoiceMail(invoiceId, invoice?.status === "paid" ? "invoice.paid" : "invoice.created", "invoice.resent");
}

/** The reset link must leave or the user is stuck, so this one is awaited. */
export const sendPasswordReset = (userId: string, token: string, minutes: number) =>
  accountMail(userId, "account.password_reset", { minutes: String(minutes) }, ({ t, origin }) => ({
    label: t("Choose a new password"),
    url: `${origin}/reset-password?token=${encodeURIComponent(token)}`,
  }));

/** HTML of a template with sample data, for the admin editor preview. */
export async function previewTemplate(id: string): Promise<string | null> {
  const def = templateDef(id);
  if (!def) return null;
  const [general, theme] = await Promise.all([getSettings("general"), getSettings("theme")]);
  const t = makeT(general.locale);
  const db = await getDb();
  const override = await db.query.emailTemplates.findFirst({ where: eq(schema.emailTemplates.id, id) });
  const wording = composeTemplate(def, override && { ...override, enabled: true }, { ...def.sample, site: general.siteName }, t)!;
  const origin = mailOrigin(general);
  const content: MailContent = {
    ...wording,
    greeting: def.audience === "client" ? t("Hi {name},", { name: def.sample.name }) : undefined,
    details: id.startsWith("invoice.") ? [[t("Invoice"), def.sample.number], [t("Total"), def.sample.total], [t("Due"), def.sample.date]] : undefined,
    quote: id.startsWith("ticket.") ? "Lorem ipsum dolor sit amet, consectetur adipiscing elit." : undefined,
    cta: { label: t("View"), url: origin || "#" },
  };
  return renderMail(content, { general, theme, origin }).html;
}

export async function sendTestMail(to: string) {
  const [general, theme] = await Promise.all([getSettings("general"), getSettings("theme")]);
  const t = makeT(general.locale);
  const origin = mailOrigin(general);
  const content: MailContent = {
    subject: t("Test email from {site}", { site: general.siteName }),
    heading: t("It works!"),
    paragraphs: [t("This is a test message. If you can read it, your SMTP settings are correct.")],
    cta: origin ? { label: t("Open the admin panel"), url: `${origin}/admin` } : undefined,
  };
  return sendMail({ to, template: "system.test", subject: content.subject, ...renderMail(content, { general, theme, origin }) }, { force: true });
}

/** Awaited: the inviter should know whether the invitation actually left. */
export async function sendTeamInvite(args: { to: string; token: string; role: string; inviter: { firstName: string; lastName: string; email: string }; ownerId: string }): Promise<SendResult> {
  const ctx = await context();
  const owner = ctx && (await loadUser(args.ownerId));
  if (!ctx || !owner) return { ok: false, error: "Email is not configured" };
  const roleLabel = { admin: "Administrator", developer: "Developer", billing: "Billing" }[args.role] ?? args.role;
  return ctx.send({
    id: "team.invite",
    to: args.to,
    vars: { inviter: displayName(args.inviter), account: owner.company || displayName(owner), role: ctx.t(roleLabel) },
    structure: { cta: { label: ctx.t("Accept invitation"), url: `${ctx.origin}/invite?token=${encodeURIComponent(args.token)}` } },
  });
}
