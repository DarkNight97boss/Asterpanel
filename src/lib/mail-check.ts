import { Resolver } from "node:dns/promises";

/** Is this domain set up to send and receive email properly? Looks at public DNS only. */

export type MailFinding = { level: "ok" | "warning" | "problem"; text: string };
export type MailDns = { mx: { exchange: string; priority: number }[]; txt: string[]; dmarc: string[] };

/** Pure: judges what DNS returned. */
export function judgeMailDns(dns: MailDns): MailFinding[] {
  const out: MailFinding[] = [];
  const nullMx = dns.mx.length === 1 && (dns.mx[0].exchange === "" || dns.mx[0].exchange === ".");
  if (!dns.mx.length) out.push({ level: "problem", text: "No MX record: this domain cannot receive email" });
  else if (nullMx) out.push({ level: "ok", text: "Null MX: the domain declares that it receives no email" });
  else out.push({ level: "ok", text: `Mail is received by ${dns.mx.sort((a, b) => a.priority - b.priority).map((m) => m.exchange).join(", ")}` });

  const spf = dns.txt.filter((t) => /^v=spf1(\s|$)/i.test(t));
  if (!spf.length) out.push({ level: "problem", text: "No SPF record: other servers cannot tell who may send for this domain, and mail often lands in spam" });
  else if (spf.length > 1) out.push({ level: "problem", text: "More than one SPF record: receivers treat that as an error. Merge them into one" });
  else {
    const record = spf[0];
    const lookups = (record.match(/\b(include:|a(?=[:\s/]|$)|mx(?=[:\s/]|$)|ptr|exists:|redirect=)/gi) ?? []).length;
    if (/[+?]all\b/i.test(record)) out.push({ level: "problem", text: "SPF ends with +all or ?all: it allows anyone to send as this domain" });
    else if (!/[-~]all\b/i.test(record) && !/redirect=/i.test(record)) out.push({ level: "warning", text: "SPF has no -all or ~all at the end: it does not say what to do with other senders" });
    else out.push({ level: "ok", text: `SPF is in place (${/-all\b/i.test(record) ? "strict" : "soft fail"})` });
    if (lookups > 10) out.push({ level: "problem", text: `SPF needs ${lookups} DNS lookups; the limit is 10, beyond which it fails` });
  }

  const dmarc = dns.dmarc.filter((t) => /^v=DMARC1\b/i.test(t));
  if (!dmarc.length) out.push({ level: "warning", text: "No DMARC record: big mailbox providers now expect one. Start with p=none" });
  else {
    const policy = /\bp=(none|quarantine|reject)\b/i.exec(dmarc[0])?.[1]?.toLowerCase();
    if (!policy) out.push({ level: "problem", text: "The DMARC record has no valid policy (p=)" });
    else out.push(policy === "none" ? { level: "warning", text: "DMARC is monitoring only (p=none): spoofed mail is still delivered" } : { level: "ok", text: `DMARC enforces ${policy}` });
  }
  return out;
}

/** Asks public resolvers, never the local network's. */
export async function checkMailDns(domain: string): Promise<MailFinding[]> {
  if (!/^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(domain)) throw new Error("Invalid domain");
  const resolver = new Resolver({ timeout: 4000, tries: 2 });
  resolver.setServers(["1.1.1.1", "9.9.9.9"]);
  const none = <T,>(p: Promise<T[]>) => p.catch(() => [] as T[]);
  const [mx, txt, dmarc] = await Promise.all([none(resolver.resolveMx(domain)), none(resolver.resolveTxt(domain)), none(resolver.resolveTxt(`_dmarc.${domain}`))]);
  return judgeMailDns({ mx, txt: txt.map((parts) => parts.join("")), dmarc: dmarc.map((parts) => parts.join("")) });
}
