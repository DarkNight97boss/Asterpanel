/** DNS helpers without I/O: ready-made record sets and a zone-file reader. */

export type PlainRecord = { name: string; type: string; value: string; ttl: number; priority: number };

const rec = (name: string, type: string, value: string, priority = 0, ttl = 3600): PlainRecord => ({ name, type, value, ttl, priority });

export const DNS_TEMPLATES: { id: string; name: string; description: string; records: (domain: string) => PlainRecord[] }[] = [
  {
    id: "google-workspace",
    name: "Google Workspace",
    description: "Mail through Google: MX and SPF.",
    records: () => [rec("@", "MX", "smtp.google.com", 1), rec("@", "TXT", "v=spf1 include:_spf.google.com ~all")],
  },
  {
    id: "microsoft-365",
    name: "Microsoft 365",
    description: "Mail through Exchange Online: MX, SPF and autodiscover.",
    records: (domain) => [rec("@", "MX", `${domain.replace(/\./g, "-")}.mail.protection.outlook.com`, 0), rec("@", "TXT", "v=spf1 include:spf.protection.outlook.com -all"), rec("autodiscover", "CNAME", "autodiscover.outlook.com")],
  },
  {
    id: "zoho-mail-eu",
    name: "Zoho Mail (EU)",
    description: "Mail through Zoho's European data centre: MX and SPF.",
    records: () => [rec("@", "MX", "mx.zoho.eu", 10), rec("@", "MX", "mx2.zoho.eu", 20), rec("@", "MX", "mx3.zoho.eu", 50), rec("@", "TXT", "v=spf1 include:zohomail.eu ~all")],
  },
  {
    id: "no-mail",
    name: "This domain sends no email",
    description: "Tells the world to reject any mail claiming to come from this domain: null MX, strict SPF and DMARC.",
    records: () => [rec("@", "TXT", "v=spf1 -all"), rec("_dmarc", "TXT", "v=DMARC1; p=reject; sp=reject; adkim=s; aspf=s")],
  },
  {
    id: "dmarc-monitor",
    name: "DMARC, monitoring only",
    description: "A first DMARC policy that changes nothing yet: a safe start before enforcing.",
    records: () => [rec("_dmarc", "TXT", "v=DMARC1; p=none")],
  },
];

const TYPES = new Set(["A", "AAAA", "CNAME", "MX", "TXT", "CAA", "SRV"]);

/**
 * Reads the records we can host out of a BIND-style zone file (as exported by
 * most DNS providers). SOA and NS are skipped: those are ours. Names come back
 * relative to the zone ("@", "www"); what cannot be read is reported, not guessed.
 */
export function parseZoneFile(text: string, zone: string): { records: PlainRecord[]; skipped: string[] } {
  const records: PlainRecord[] = [];
  const skipped: string[] = [];
  // Join ( … ) continuations, then strip comments outside quotes.
  const joined = text.replace(/\(([^)]*)\)/g, (_, inner: string) => inner.replace(/;[^\n]*/g, " ").replace(/\s+/g, " "));
  let origin = `${zone.toLowerCase()}.`;
  let defaultTtl = 3600;
  let last = "@";

  for (const raw of joined.split(/\r?\n/)) {
    const line = raw.replace(/("(?:[^"\\]|\\.)*")|;.*$/g, (m, quoted: string) => quoted ?? "").trimEnd();
    if (!line.trim()) continue;
    const directive = /^\$(ORIGIN|TTL)\s+(\S+)/i.exec(line);
    if (directive) {
      if (directive[1].toUpperCase() === "TTL") defaultTtl = Number(directive[2]) || defaultTtl;
      else origin = directive[2].toLowerCase().replace(/\.?$/, ".");
      continue;
    }
    const tokens = line.match(/"(?:[^"\\]|\\.)*"|\S+/g) ?? [];
    // A line starting with whitespace re-uses the previous owner name.
    let name = /^\s/.test(line) ? last : tokens.shift()!;
    last = name;
    let ttl = defaultTtl;
    while (tokens.length && (/^\d+$/.test(tokens[0]!) || /^IN$/i.test(tokens[0]!))) {
      const tk = tokens.shift()!;
      if (/^\d+$/.test(tk)) ttl = Number(tk);
    }
    const type = (tokens.shift() ?? "").toUpperCase();
    if (type === "SOA" || type === "NS") continue;
    if (!TYPES.has(type) || !tokens.length) {
      skipped.push(raw.trim().slice(0, 120));
      continue;
    }
    // Absolute → relative to the zone; anything outside the zone is not ours to host.
    const fqdn = name === "@" ? origin : name.endsWith(".") ? name.toLowerCase() : `${name.toLowerCase()}.${origin}`;
    const apex = `${zone.toLowerCase()}.`;
    if (fqdn !== apex && !fqdn.endsWith(`.${apex}`)) {
      skipped.push(raw.trim().slice(0, 120));
      continue;
    }
    name = fqdn === apex ? "@" : fqdn.slice(0, -apex.length - 1);
    const absolute = (host: string) => (host === "@" ? apex : host.endsWith(".") ? host : `${host}.${origin}`).replace(/\.$/, "");

    let priority = 0;
    let value: string;
    if (type === "MX") {
      priority = Number(tokens[0]) || 0;
      value = absolute(tokens[1] ?? "");
    } else if (type === "SRV") {
      priority = Number(tokens[0]) || 0;
      value = `${tokens[1]} ${tokens[2]} ${absolute(tokens[3] ?? "")}`;
    } else if (type === "CNAME") value = absolute(tokens[0] ?? "");
    else if (type === "TXT") value = tokens.map((tk) => (tk.startsWith('"') ? tk.slice(1, -1).replace(/\\(.)/g, "$1") : tk)).join("");
    else value = tokens.join(" ");
    records.push({ name, type, value, ttl, priority });
  }
  return { records, skipped };
}
