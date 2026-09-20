import assert from "node:assert/strict";
import { before, test } from "node:test";
import { eq } from "drizzle-orm";

process.env.PGLITE_DIR = "memory://";
process.env.APP_SECRET = "test-secret";

import { stripQuotedReply, subjectTicketNumber, ticketReplyAddress, ticketToken } from "../src/lib/ticket-address";

let dbm: typeof import("../src/db");
let tickets: typeof import("../src/lib/tickets");
let clientId: string, colleagueId: string, strangerId: string, staffId: string, companyId: string;
let ticket: { id: string; number: number };

const mime = (o: { from: string; to?: string; subject?: string; body: string; headers?: string[]; attachment?: { name: string; content: string } }) => {
  const head = [`From: ${o.from}`, `To: ${o.to ?? "support@host.test"}`, `Subject: ${o.subject ?? "Help"}`, "MIME-Version: 1.0", ...(o.headers ?? [])];
  if (!o.attachment) return [...head, "Content-Type: text/plain; charset=utf-8", "", o.body].join("\r\n");
  return [...head, 'Content-Type: multipart/mixed; boundary="b1"', "", "--b1", "Content-Type: text/plain; charset=utf-8", "", o.body, "--b1", `Content-Type: application/octet-stream; name="${o.attachment.name}"`, `Content-Disposition: attachment; filename="${o.attachment.name}"`, "Content-Transfer-Encoding: base64", "", Buffer.from(o.attachment.content).toString("base64"), "--b1--", ""].join("\r\n");
};
const messagesOf = async (id: string) => (await dbm.getDb()).select().from(dbm.schema.ticketMessages).where(eq(dbm.schema.ticketMessages.ticketId, id)).orderBy(dbm.schema.ticketMessages.createdAt);

before(async () => {
  dbm = await import("../src/db");
  tickets = await import("../src/lib/tickets");
  const { updateSettings } = await import("../src/lib/settings");
  await updateSettings("mail", { inboundEnabled: true, inboundAddress: "support@host.test", inboundPlus: true, inboundToken: "tok", fromEmail: "noreply@host.test" });
  const db = await dbm.getDb();
  const users = await db.insert(dbm.schema.users).values([{ email: "Anna@Client.test", passwordHash: "x" }, { email: "collega@client.test", passwordHash: "x" }, { email: "stranger@else.test", passwordHash: "x" }, { email: "help@host.test", passwordHash: "x", role: "admin" }, { email: "gone@client.test", passwordHash: "x", status: "suspended" }]).returning();
  [clientId, colleagueId, strangerId, staffId] = users.map((u) => u.id);
  [{ id: companyId }] = await db.insert(dbm.schema.companies).values({ name: "Client Srl" }).returning();
  await db.insert(dbm.schema.companyMembers).values([{ companyId, userId: clientId, email: "anna@client.test", role: "owner", acceptedAt: new Date() }, { companyId, userId: colleagueId, email: "collega@client.test", role: "developer", acceptedAt: new Date() }]);
});

test("reply addresses carry a keyed proof; quoted threads and signatures are cut", () => {
  const mail = { inboundEnabled: true, inboundAddress: "support@host.test", inboundPlus: true };
  const address = ticketReplyAddress(mail, { id: "11111111-1111-4111-8111-111111111111", number: 42 })!;
  assert.match(address, /^support\+t42-[0-9a-f]{16}@host\.test$/);
  assert.deepEqual(ticketToken(["x@y.test", address])?.number, 42);
  assert.equal(ticketToken(["support+t42-short@host.test"]), null);
  assert.equal(ticketReplyAddress({ ...mail, inboundPlus: false }, { id: "x", number: 1 }), "support@host.test");
  assert.equal(ticketReplyAddress({ ...mail, inboundEnabled: false }, { id: "x", number: 1 }), null);
  assert.equal(subjectTicketNumber("Re: [#1207] Sito lento"), 1207);
  assert.equal(subjectTicketNumber("Offerta #12"), null);

  assert.equal(stripQuotedReply("Grazie, ora funziona.\n\nIl giorno lun 3 ago 2026 alle 10:12 Supporto <s@host.test> ha scritto:\n> Provi ora\n> saluti"), "Grazie, ora funziona.");
  assert.equal(stripQuotedReply("Works now.\r\n\r\nOn Mon, Aug 3, 2026 at 10:12 AM Support\r\n<s@host.test> wrote:\r\n> try now"), "Works now.");
  assert.equal(stripQuotedReply("Ok\n-- \nAnna Rossi\nClient Srl"), "Ok");
  assert.equal(stripQuotedReply("Vedi sotto\n\n-----Original Message-----\nFrom: x"), "Vedi sotto");
  assert.equal(stripQuotedReply("> solo citazione"), "");
});

test("a known customer opens a ticket by email, attachment included; machines and strangers are dropped", async () => {
  const opened = await tickets.handleInboundMail(mime({ from: "Anna Rossi <anna@client.test>", subject: "Fwd: Sito lento", body: "Il sito è lento da ieri.", attachment: { name: "../../trace.log", content: "slow query" } }));
  assert.equal(opened.outcome, "opened");
  const db = await dbm.getDb();
  const [row] = await db.select().from(dbm.schema.tickets);
  ticket = row;
  assert.deepEqual([row.subject, row.clientId, row.companyId, row.status], ["Sito lento", clientId, companyId, "open"]);
  const [message] = await messagesOf(row.id);
  assert.deepEqual([message.body, message.via], ["Il sito è lento da ieri.", "email"]);
  const files = (await tickets.attachmentsOf(row.id)).get(message.id)!;
  assert.deepEqual(files.map((f) => [f.name, f.size]), [[".._.._trace.log".replace(/^\.+/, ""), 10]]);

  const ignored = async (m: string) => { const r = await tickets.handleInboundMail(m); assert.equal(r.outcome, "ignored"); return (r as { reason: string }).reason; };
  assert.equal(await ignored(mime({ from: "nobody@spam.test", body: "Buy now" })), "unknown sender");
  assert.equal(await ignored(mime({ from: "gone@client.test", body: "Let me in" })), "unknown sender");
  assert.equal(await ignored(mime({ from: "anna@client.test", body: "Sono in ferie", headers: ["Auto-Submitted: auto-replied"] })), "automatic message");
  assert.equal(await ignored(mime({ from: "MAILER-DAEMON@mx.test", body: "Undelivered" })), "automatic message");
  assert.equal(await ignored(mime({ from: "support@host.test", body: "loop" })), "our own address");
  assert.equal(await ignored(mime({ from: "help@host.test", body: "Staff writing in" })), "staff cannot open tickets by email");
  assert.equal((await db.select().from(dbm.schema.tickets)).length, 1);
});

test("replies: the signed address or the subject finds the ticket, the sender must belong to it", async () => {
  const db = await dbm.getDb();
  const { ticketReplyAddress: addr } = await import("../src/lib/ticket-address");
  const to = addr({ inboundEnabled: true, inboundAddress: "support@host.test", inboundPlus: true }, ticket)!;

  assert.deepEqual(await tickets.handleInboundMail(mime({ from: "help@host.test", to, body: "Abbiamo riavviato il servizio.\n\nOn Mon, Aug 3, 2026 Anna wrote:\n> Il sito è lento" })), { outcome: "reply", ticketId: ticket.id });
  assert.equal((await db.select().from(dbm.schema.tickets))[0].status, "answered");
  await db.update(dbm.schema.tickets).set({ status: "closed" }).where(eq(dbm.schema.tickets.id, ticket.id));
  // A colleague of the same company answers, matched by subject; the closed ticket re-opens.
  assert.equal((await tickets.handleInboundMail(mime({ from: "collega@client.test", subject: `Re: [#${ticket.number}] Sito lento`, body: "Confermo, ora va." }))).outcome, "reply");
  assert.equal((await db.select().from(dbm.schema.tickets))[0].status, "customer_reply");
  assert.deepEqual((await messagesOf(ticket.id)).map((m) => m.body), ["Il sito è lento da ieri.", "Abbiamo riavviato il servizio.", "Confermo, ora va."]);

  // Somebody else who learnt the number, or who tampers with the address, is not heard — and no ticket is opened for them.
  assert.deepEqual(await tickets.handleInboundMail(mime({ from: "stranger@else.test", subject: `[#${ticket.number}]`, body: "Send me the password" })), { outcome: "ignored", reason: "sender is not on this ticket" });
  assert.deepEqual(await tickets.handleInboundMail(mime({ from: "anna@client.test", to: to.replace(/-[0-9a-f]{16}@/, "-0123456789abcdef@"), body: "forged" })), { outcome: "ignored", reason: "reply address not valid" });
  assert.equal((await messagesOf(ticket.id)).length, 3);
  assert.equal((await db.select().from(dbm.schema.tickets)).length, 1);
  void strangerId; void staffId; void colleagueId;
});

test("uploads: kinds, size and count are enforced; an unacceptable email attachment does not lose the message", async () => {
  const file = (name: string, bytes = 10) => ({ name, mime: "text/plain", data: Buffer.alloc(bytes, 1) });
  assert.deepEqual(tickets.checkUploads([file("report final (1).PDF"), file("empty.txt", 0)]).map((f) => f.name), ["report final (1).PDF"]);
  assert.throws(() => tickets.checkUploads([file("run.exe")]), /run\.exe: this kind/);
  assert.throws(() => tickets.checkUploads([file("page.html")]), /cannot be attached/);
  assert.throws(() => tickets.checkUploads([file("big.zip", 5 * 1024 * 1024 + 1)]), /up to 5 MB/);
  assert.throws(() => tickets.checkUploads(Array.from({ length: 6 }, (_, i) => file(`f${i}.txt`))), /At most 5/);
  assert.equal(tickets.checkUploads([{ name: "a.txt", mime: "text/html\r\nX: y", data: Buffer.from("x") }])[0].mime, "application/octet-stream");

  const r = await tickets.handleInboundMail(mime({ from: "anna@client.test", subject: `[#${ticket.number}]`, body: "Ecco il file", attachment: { name: "virus.exe", content: "MZ" } }));
  assert.equal(r.outcome, "reply");
  const last = (await messagesOf(ticket.id)).at(-1)!;
  assert.match(last.body, /^Ecco il file\n\n\[1 attachment\(s\) could not be accepted\]$/);
  assert.equal((await tickets.attachmentsOf(ticket.id)).get(last.id), undefined);
});
