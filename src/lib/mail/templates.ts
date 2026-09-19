/**
 * Registry of transactional emails.
 *
 * Each template has built-in wording (English source strings, translated via
 * i18n like the rest of the UI) and a list of `{variables}`. Admins may
 * override subject, heading and body per template, or switch a template off.
 * Structural parts — greeting, summary box, quoted reply, button — stay in
 * code so an edited template can never lose its payment link or PDF.
 *
 * To add an email: add an entry here, then send it from `src/lib/notify.ts`.
 */

export type TemplateDef = {
  id: string;
  name: string;
  description: string;
  audience: "client" | "staff";
  variables: Record<string, string>;
  subject: string;
  heading: string;
  /** Paragraphs. */
  body: string[];
  /** Values used by the admin preview. */
  sample: Record<string, string>;
};

const common = { site: "Site name", name: "Client's first name" };
const sampleCommon = { site: "Acme Hosting", name: "Mario" };
const invoiceVars = { ...common, number: "Invoice number", total: "Invoice total", date: "Due date" };
const invoiceSample = { ...sampleCommon, number: "INV-1042", total: "€109.68", date: "Oct 18, 2026" };
const serviceVars = { ...common, service: "Product name and domain" };
const serviceSample = { ...sampleCommon, service: "Hosting Business (example.com)" };
const ticketVars = { ...common, number: "Ticket number", subject: "Ticket subject", client: "Client's full name" };
const ticketSample = { ...sampleCommon, number: "128", subject: "Cannot connect via FTP", client: "Mario Rossi" };

export const TEMPLATES: TemplateDef[] = [
  {
    id: "account.welcome",
    name: "Welcome",
    description: "Sent when a client registers.",
    audience: "client",
    variables: common,
    subject: "Welcome to {site}",
    heading: "Welcome to {site}",
    body: ["Your account is ready. From the client area you can order services, pay invoices and contact our support team."],
    sample: sampleCommon,
  },
  {
    id: "account.password_reset",
    name: "Password reset",
    description: "Sent when someone asks to reset a password.",
    audience: "client",
    variables: { ...common, minutes: "Link validity in minutes" },
    subject: "Reset your {site} password",
    heading: "Reset your password",
    body: [
      "We received a request to reset the password of your account. The link below is valid for {minutes} minutes and can be used once.",
      "If you did not ask for this, you can safely ignore this email: your password will not change.",
    ],
    sample: { ...sampleCommon, minutes: "60" },
  },
  {
    id: "account.password_changed",
    name: "Password changed",
    description: "Security notice after a password change.",
    audience: "client",
    variables: common,
    subject: "Your {site} password was changed",
    heading: "Your password was changed",
    body: ["The password of your account has just been changed. If it was you, no action is needed.", "If it was not you, reset your password now and contact our support team."],
    sample: sampleCommon,
  },
  {
    id: "team.invite",
    name: "Team invitation",
    description: "Sent when someone is invited to help manage an account.",
    audience: "client",
    variables: { site: "Site name", inviter: "Who sent the invite", account: "Account name", role: "Role granted" },
    subject: "{inviter} invited you to {account} on {site}",
    heading: "You have been invited to a team",
    body: ["{inviter} invited you to help manage {account} as {role}.", "Accept with the button below. If you do not have an account yet, create one with this email address first. The invitation expires in 7 days."],
    sample: { site: "Acme Hosting", inviter: "Mario Rossi", account: "Rossi Web Agency", role: "Developer" },
  },
  {
    id: "invoice.created",
    name: "New invoice",
    description: "Sent for new orders and renewals, with the PDF attached.",
    audience: "client",
    variables: invoiceVars,
    subject: "Invoice {number} — due {date}",
    heading: "You have a new invoice",
    body: ["A new invoice has been issued on your account. You will find it attached as a PDF."],
    sample: invoiceSample,
  },
  {
    id: "invoice.paid",
    name: "Payment received",
    description: "Receipt sent when an invoice becomes paid, with the PDF attached.",
    audience: "client",
    variables: invoiceVars,
    subject: "Payment received for invoice {number}",
    heading: "Thank you for your payment",
    body: ["We have received your payment. The paid invoice is attached for your records."],
    sample: invoiceSample,
  },
  {
    id: "invoice.reminder",
    name: "Overdue reminder",
    description: "Sent on the days configured in Billing while an invoice stays unpaid.",
    audience: "client",
    variables: { ...invoiceVars, days: "Days past the due date" },
    subject: "Reminder: invoice {number} is overdue",
    heading: "Your invoice is overdue",
    body: [
      "Invoice {number} of {total} was due on {date} and is now {days} days overdue.",
      "Please pay it as soon as possible to avoid the suspension of your services. If you have already paid, thank you — you can ignore this message.",
    ],
    sample: { ...invoiceSample, days: "7" },
  },
  {
    id: "service.activated",
    name: "Service activated",
    description: "Sent when a service is provisioned.",
    audience: "client",
    variables: serviceVars,
    subject: "Your service is active: {service}",
    heading: "Your service is active",
    body: ["Good news: {service} has been activated and is ready to use."],
    sample: serviceSample,
  },
  {
    id: "service.suspended",
    name: "Service suspended",
    description: "Sent when a service is suspended, by staff or for non-payment.",
    audience: "client",
    variables: { ...serviceVars, reason: "Suspension reason" },
    subject: "Service suspended: {service}",
    heading: "Your service has been suspended",
    body: ["{service} has been suspended.", "Reason: {reason}", "If an invoice is overdue, paying it reactivates the service automatically."],
    sample: { ...serviceSample, reason: "Overdue on payment" },
  },
  {
    id: "service.unsuspended",
    name: "Service reactivated",
    description: "Sent when a suspension is lifted.",
    audience: "client",
    variables: serviceVars,
    subject: "Service reactivated: {service}",
    heading: "Your service is active again",
    body: ["{service} has been reactivated. Thank you!"],
    sample: serviceSample,
  },
  {
    id: "service.terminated",
    name: "Service terminated",
    description: "Sent when a service is terminated.",
    audience: "client",
    variables: serviceVars,
    subject: "Service terminated: {service}",
    heading: "Your service has been terminated",
    body: ["{service} has been terminated and its data removed. Contact us if you think this is a mistake."],
    sample: serviceSample,
  },
  {
    id: "uptime.down",
    name: "Site down",
    description: "Sent when the uptime monitor fails twice in a row.",
    audience: "client",
    variables: { ...serviceVars, reason: "What the monitor saw" },
    subject: "{service} is not responding",
    heading: "Your site is not responding",
    body: ["Our monitor could not reach {service} twice in a row.", "What we saw: {reason}", "We keep checking every few minutes and will tell you as soon as it is back."],
    sample: { ...serviceSample, reason: "HTTP 502" },
  },
  {
    id: "uptime.up",
    name: "Site back up",
    description: "Sent when a site answers again after an incident.",
    audience: "client",
    variables: serviceVars,
    subject: "{service} is back online",
    heading: "Your site is back online",
    body: ["{service} is answering normally again."],
    sample: serviceSample,
  },
  {
    id: "ticket.staff_reply",
    name: "Ticket reply",
    description: "Sent to the client when staff replies. The reply is quoted below the text.",
    audience: "client",
    variables: ticketVars,
    subject: "[#{number}] {subject}",
    heading: "New reply to your ticket",
    body: ["Our team has replied to your support request:"],
    sample: ticketSample,
  },
  {
    id: "ticket.opened",
    name: "New ticket",
    description: "Sent to staff when a client opens a ticket.",
    audience: "staff",
    variables: ticketVars,
    subject: "[#{number}] {subject}",
    heading: "New ticket from {client}",
    body: [],
    sample: ticketSample,
  },
  {
    id: "ticket.client_reply",
    name: "Client reply",
    description: "Sent to staff when a client replies to a ticket.",
    audience: "staff",
    variables: ticketVars,
    subject: "[#{number}] {subject}",
    heading: "{client} replied to a ticket",
    body: [],
    sample: ticketSample,
  },
];

export const templateDef = (id: string) => TEMPLATES.find((t) => t.id === id);

export const interpolate = (text: string, vars: Record<string, string>) =>
  text.replace(/\{(\w+)\}/g, (match, key: string) => (key in vars ? vars[key] : match));

export type TemplateOverride = { enabled: boolean; subject: string; heading: string; body: string };

/**
 * Final wording of a template: the admin's text where provided, otherwise the
 * translated default. Returns null when the template is switched off.
 */
export function composeTemplate(
  def: TemplateDef,
  override: TemplateOverride | undefined,
  vars: Record<string, string>,
  t: (source: string) => string,
): { subject: string; heading: string; paragraphs: string[] } | null {
  if (override && !override.enabled) return null;
  // Header injection guard: a subject is always a single line.
  const line = (s: string) => interpolate(s, vars).replace(/[\r\n]+/g, " ").trim();
  return {
    subject: line(override?.subject || t(def.subject)),
    heading: line(override?.heading || t(def.heading)),
    paragraphs: (override?.body ? override.body.split(/\n\s*\n/) : def.body.map(t)).map((p) => interpolate(p.trim(), vars)).filter(Boolean),
  };
}
