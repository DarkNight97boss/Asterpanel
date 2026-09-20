import "server-only";
import { and, eq, sql } from "drizzle-orm";
import { simpleParser } from "mailparser";
import { getDb, schema } from "@/db";
import { audit } from "./audit";
import { macOf, safeEqual } from "./crypto";
import { notify } from "./notify";
import { getSettings } from "./settings";
import { staffCan } from "./staff";
import { stripQuotedReply, subjectTicketNumber, ticketToken } from "./ticket-address";

export class TicketError extends Error {}

// ─── Attachments ─────────────────────────────────────────────────────────────

export const MAX_ATTACHMENTS = 5;
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
/** By extension: what support really receives. Anything a browser could run is left out, and downloads are forced anyway. */
const ALLOWED = new Set(["png", "jpg", "jpeg", "gif", "webp", "pdf", "txt", "log", "csv", "json", "xml", "zip", "gz", "har", "doc", "docx", "xls", "xlsx", "odt", "ods", "eml"]);

export type Upload = { name: string; mime: string; data: Buffer };

/** Keeps what may be stored; throws on the first file that may not, naming it. */
export function checkUploads(files: Upload[]): Upload[] {
  const real = files.filter((f) => f.data.length > 0);
  if (real.length > MAX_ATTACHMENTS) throw new TicketError(`At most ${MAX_ATTACHMENTS} files per message`);
  return real.map((f) => {
    // Letters, digits and a few harmless signs: no paths, quotes or control characters survive.
    const name = f.name.replace(/[^\p{L}\p{N} ._()+@-]/gu, "_").replace(/^\.+/, "").slice(-120) || "file";
    const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
    if (!ALLOWED.has(ext)) throw new TicketError(`${name}: this kind of file cannot be attached`);
    if (f.data.length > MAX_ATTACHMENT_BYTES) throw new TicketError(`${name}: files can be up to 5 MB`);
    return { name, mime: /^[\w.+-]+\/[\w.+-]+$/.test(f.mime) ? f.mime : "application/octet-stream", data: f.data };
  });
}

export async function uploadsFrom(form: FormData, field = "files"): Promise<Upload[]> {
  const files = form.getAll(field).filter((f): f is File => typeof f === "object" && "arrayBuffer" in f && f.size > 0);
  // Size first: never read a huge body into memory just to refuse it.
  const big = files.find((f) => f.size > MAX_ATTACHMENT_BYTES);
  if (big) throw new TicketError(`${big.name.slice(0, 80)}: files can be up to 5 MB`);
  if (files.length > MAX_ATTACHMENTS) throw new TicketError(`At most ${MAX_ATTACHMENTS} files per message`);
  return checkUploads(await Promise.all(files.map(async (f) => ({ name: f.name, mime: f.type, data: Buffer.from(await f.arrayBuffer()) }))));
}

export async function attach(ticketId: string, messageId: string, files: Upload[]) {
  if (!files.length) return;
  await (await getDb()).insert(schema.ticketAttachments).values(files.map((f) => ({ ticketId, messageId, name: f.name, mime: f.mime, size: f.data.length, data: f.data })));
}

/** Names and sizes per message, without the bytes. */
export async function attachmentsOf(ticketId: string) {
  const rows = await (await getDb()).select({ id: schema.ticketAttachments.id, messageId: schema.ticketAttachments.messageId, name: schema.ticketAttachments.name, size: schema.ticketAttachments.size }).from(schema.ticketAttachments).where(eq(schema.ticketAttachments.ticketId, ticketId));
  const byMessage = new Map<string, typeof rows>();
  for (const r of rows) byMessage.set(r.messageId, [...(byMessage.get(r.messageId) ?? []), r]);
  return byMessage;
}

// ─── Tickets by email ────────────────────────────────────────────────────────

export type InboundResult = { outcome: "reply" | "opened"; ticketId: string } | { outcome: "ignored"; reason: string };

type Parsed = Awaited<ReturnType<typeof simpleParser>>;
const header = (mail: Parsed, name: string) => String(mail.headers.get(name) ?? "").toLowerCase();

/**
 * One received message → a reply on its ticket, or a new ticket. Who it is
 * from is decided by the sender's address, so only people already known here
 * are listened to: an answer must come from the customer's side of that ticket
 * (or from support staff), a new ticket from an active customer. Everything
 * else, and anything written by a machine, is dropped with a reason.
 */
export async function handleInboundMail(raw: Buffer | string): Promise<InboundResult> {
  const settings = await getSettings("mail");
  if (!settings.inboundEnabled) return { outcome: "ignored", reason: "tickets by email are off" };
  const mail = await simpleParser(raw);
  const from = mail.from?.value[0]?.address?.toLowerCase() ?? "";
  if (!from) return { outcome: "ignored", reason: "no sender" };
  // Loops: our own notifications, auto-replies, mailing lists, bounces.
  const auto = header(mail, "auto-submitted");
  if ((auto && auto !== "no") || /bulk|junk|list|auto_reply/.test(header(mail, "precedence")) || mail.headers.has("x-autoreply") || mail.headers.has("x-autorespond") || mail.headers.has("list-id") || /^(mailer-daemon|postmaster|no-?reply)@/.test(from)) return { outcome: "ignored", reason: "automatic message" };
  if ([settings.fromEmail, settings.inboundAddress].some((own) => own && own.toLowerCase() === from)) return { outcome: "ignored", reason: "our own address" };

  const db = await getDb();
  const [sender] = await db.select().from(schema.users).where(eq(sql`lower(${schema.users.email})`, from));
  if (!sender || sender.status !== "active") return { outcome: "ignored", reason: "unknown sender" };

  const text = stripQuotedReply(mail.text ?? "").slice(0, 20_000);
  const files: Upload[] = [];
  let skipped = 0;
  for (const a of mail.attachments.filter((a) => !a.related)) {
    try {
      if (files.length >= MAX_ATTACHMENTS) throw new TicketError("too many");
      files.push(...checkUploads([{ name: a.filename ?? "file", mime: a.contentType, data: a.content }]));
    } catch {
      skipped++; // an .exe or a sixth file must not lose the message itself
    }
  }
  const body = (text || (files.length ? "(attachment)" : "")) + (skipped ? `\n\n[${skipped} attachment(s) could not be accepted]` : "");
  if (body.trim().length < 2) return { outcome: "ignored", reason: "empty message" };

  const recipients = [mail.to, mail.cc].flat().flatMap((a) => a?.value ?? []).map((v) => v.address ?? "");
  const token = ticketToken(recipients);
  const number = token?.number ?? subjectTicketNumber(mail.subject ?? "");
  const [ticket] = number ? await db.select().from(schema.tickets).where(eq(schema.tickets.number, number)) : [];
  // A forged or mistyped token is not a reason to open a new ticket in somebody's name.
  if (token && (!ticket || !safeEqual(macOf(ticket.id), token.mac))) return { outcome: "ignored", reason: "reply address not valid" };

  if (ticket) {
    const staff = staffCan(sender, "support");
    const member = ticket.clientId === sender.id || (ticket.companyId ? (await db.select({ id: schema.companyMembers.id }).from(schema.companyMembers).where(and(eq(schema.companyMembers.companyId, ticket.companyId), eq(schema.companyMembers.userId, sender.id)))).length > 0 : false);
    if (!staff && !member) return { outcome: "ignored", reason: "sender is not on this ticket" };
    const [message] = await db.insert(schema.ticketMessages).values({ ticketId: ticket.id, authorId: sender.id, body, via: "email" }).returning({ id: schema.ticketMessages.id });
    await attach(ticket.id, message.id, files);
    // An answer re-opens a closed ticket: the customer should not have to find the panel to be heard.
    await db.update(schema.tickets).set({ status: staff && !member ? "answered" : "customer_reply", lastReplyAt: new Date() }).where(eq(schema.tickets.id, ticket.id));
    if (staff && !member) notify.ticketStaffReply(ticket.id, body);
    else notify.ticketClientReply(ticket.id, body);
    return { outcome: "reply", ticketId: ticket.id };
  }

  if (staffCan(sender, "support")) return { outcome: "ignored", reason: "staff cannot open tickets by email" };
  const [membership] = await db.select({ companyId: schema.companyMembers.companyId }).from(schema.companyMembers).where(eq(schema.companyMembers.userId, sender.id)).limit(1);
  const subject = (mail.subject ?? "").replace(/^\s*((re|fwd?|r|i)\s*:\s*)+/i, "").trim().slice(0, 200) || body.split("\n")[0].slice(0, 80);
  const ticketId = await db.transaction(async (tx) => {
    const [row] = await tx.insert(schema.tickets).values({ clientId: sender.id, companyId: membership?.companyId ?? null, subject, department: "support", priority: "medium" }).returning({ id: schema.tickets.id });
    const [message] = await tx.insert(schema.ticketMessages).values({ ticketId: row.id, authorId: sender.id, body, via: "email" }).returning({ id: schema.ticketMessages.id });
    if (files.length) await tx.insert(schema.ticketAttachments).values(files.map((f) => ({ ticketId: row.id, messageId: message.id, name: f.name, mime: f.mime, size: f.data.length, data: f.data })));
    return row.id;
  });
  await audit(sender.id, "ticket.opened_by_email", "ticket", ticketId);
  notify.ticketOpened(ticketId, body);
  return { outcome: "opened", ticketId };
}
