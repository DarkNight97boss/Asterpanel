import "server-only";
import nodemailer, { type Transporter } from "nodemailer";
import { getDb, schema } from "@/db";
import { getSettings, type Settings } from "../settings";

export type Attachment = { filename: string; content: Buffer; contentType: string };

export type OutgoingMail = {
  to: string;
  subject: string;
  html: string;
  text: string;
  /** Template id, recorded in the email log. */
  template: string;
  userId?: string | null;
  attachments?: Attachment[];
};

let override: Transporter | undefined;

/** Tests swap the SMTP connection for an in-memory transport. */
export function setTransportForTests(transport: Transporter | undefined) {
  override = transport;
}

function smtp(mail: Settings<"mail">): Transporter {
  return nodemailer.createTransport({
    host: mail.host,
    port: mail.port,
    secure: mail.security === "ssl",
    requireTLS: mail.security === "starttls",
    ignoreTLS: mail.security === "none",
    auth: mail.username ? { user: mail.username, pass: mail.password } : undefined,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });
}

export const mailConfigured = (mail: Settings<"mail">) => !!override || (mail.enabled && !!mail.host && !!mail.fromEmail);

/**
 * Sends one message and records the outcome in `email_log`. Returns the error
 * message instead of throwing: a broken SMTP server must never break billing.
 */
export async function sendMail(message: OutgoingMail, { force = false } = {}): Promise<{ ok: boolean; error?: string }> {
  const [mail, general] = await Promise.all([getSettings("mail"), getSettings("general")]);
  if (!force && !mailConfigured(mail)) return { ok: false, error: "Email is not configured" };

  let error = "";
  try {
    await (override ?? smtp(mail)).sendMail({
      from: { name: mail.fromName || general.siteName, address: mail.fromEmail || "noreply@localhost" },
      replyTo: general.supportEmail || undefined,
      to: message.to,
      subject: message.subject,
      html: message.html,
      text: message.text,
      attachments: message.attachments,
    });
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  const db = await getDb();
  await db
    .insert(schema.emailLog)
    .values({
      userId: message.userId ?? null,
      recipient: message.to,
      subject: message.subject,
      template: message.template,
      status: error ? "failed" : "sent",
      error: error.slice(0, 1000),
    })
    .catch(() => {});
  return error ? { ok: false, error } : { ok: true };
}
