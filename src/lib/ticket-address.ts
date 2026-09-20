import { macOf } from "./crypto";

/** Pure: the address that threads an email answer back to its ticket, and its reverse. */

type Inbound = { inboundEnabled: boolean; inboundAddress: string; inboundPlus: boolean };

/** `support+t42-9f3a…@example.com`: the number finds the ticket, the keyed part proves we issued the address. */
export function ticketReplyAddress(mail: Inbound, ticket: { id: string; number: number }): string | null {
  const [local, domain] = mail.inboundAddress.split("@");
  if (!mail.inboundEnabled || !local || !domain) return null;
  return mail.inboundPlus ? `${local}+t${ticket.number}-${macOf(ticket.id)}@${domain}` : mail.inboundAddress;
}

/** Ticket number and proof from any recipient of a message, if one of them is such an address. */
export function ticketToken(recipients: string[]): { number: number; mac: string } | null {
  for (const r of recipients) {
    const m = /\+t(\d{1,10})-([0-9a-f]{16})@/i.exec(r);
    if (m) return { number: Number(m[1]), mac: m[2].toLowerCase() };
  }
  return null;
}

/** `[#42]` in a subject: the fallback when the mailbox has no plus addressing. */
export const subjectTicketNumber = (subject: string) => Number(/\[#(\d{1,10})\]/.exec(subject)?.[1] ?? 0) || null;

const QUOTE_STARTS = [
  /^On .{5,200} wrote:\s*$/i,
  /^Il .{5,200} ha scritto:\s*$/i,
  /^Am .{5,200} schrieb .*:\s*$/i,
  /^Le .{5,200} a écrit\s*:\s*$/i,
  /^-{2,}\s*(Original Message|Messaggio originale|Forwarded message)\s*-{2,}/i,
  /^_{10,}\s*$/,
  /^(From|Da|Von|De):\s.+@.+/i,
];

/** The part the person actually wrote: the quoted thread and the mail client's signature separator are dropped. */
export function stripQuotedReply(text: string): string {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  let end = lines.length;
  for (let i = 0; i < lines.length; i++) {
    // Some clients wrap "On … wrote:" over two lines.
    if (QUOTE_STARTS.some((re) => re.test(lines[i].trim()) || re.test(`${lines[i]} ${lines[i + 1] ?? ""}`.trim())) || lines[i] === "-- ") {
      end = i;
      break;
    }
  }
  const kept = lines.slice(0, end);
  while (kept.length && (/^>/.test(kept[kept.length - 1]) || !kept[kept.length - 1].trim())) kept.pop();
  return kept.join("\n").trim();
}
