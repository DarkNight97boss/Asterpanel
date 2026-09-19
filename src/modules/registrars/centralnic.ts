import { itEntityType, RegistrarError, type DomainContact, type Http, type RegistrarCredentials, type RegistrarModule } from "./types";

/**
 * CentralNic Reseller (formerly RRPproxy) — https://www.centralnicreseller.com
 * HTTP API: one `command` per call, plain-text answer:
 *
 *   [RESPONSE]
 *   code = 200
 *   description = Command completed successfully
 *   property[expirationdate][0] = 2027-01-01 00:00:00
 *   EOF
 */

const endpoint = (c: RegistrarCredentials) => (c.sandbox === "1" ? "https://api-ote.rrpproxy.net/api/call.cgi" : "https://api.rrpproxy.net/api/call.cgi");

export type CnrResponse = { code: number; description: string; props: Record<string, string[]> };

export function parseCnr(text: string): CnrResponse {
  const out: CnrResponse = { code: 0, description: "", props: {} };
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([^=]+?)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const prop = /^property\[(.+?)\]\[(\d+)\]$/.exec(key);
    if (prop) (out.props[prop[1].replace(/\s+/g, "")] ??= [])[Number(prop[2])] = m[2];
    else if (key === "code") out.code = Number(m[2]);
    else if (key === "description") out.description = m[2];
  }
  return out;
}

async function call(c: RegistrarCredentials, http: Http, command: string, params: Record<string, string> = {}): Promise<CnrResponse> {
  const body = new URLSearchParams({ s_login: c.login ?? "", s_pw: c.password ?? "", command, ...params });
  let res: Response;
  try {
    res = await http(endpoint(c), { method: "POST", body, headers: { "Content-Type": "application/x-www-form-urlencoded" }, signal: AbortSignal.timeout(45_000) });
  } catch {
    throw new RegistrarError("CentralNic Reseller did not answer");
  }
  const parsed = parseCnr(await res.text());
  if (!parsed.code) throw new RegistrarError(`CentralNic Reseller answered with HTTP ${res.status}`);
  // 2xx = done or accepted; everything else is an error with a readable description.
  if (parsed.code < 200 || parsed.code >= 300) throw new RegistrarError(`${parsed.description} (${parsed.code})`.slice(0, 300));
  return parsed;
}

const list = (prefix: string, values: string[]) => Object.fromEntries(values.map((v, i) => [`${prefix}${i}`, v]));

/** Contacts are objects of their own here: create one handle and use it for every role. */
async function contactHandle(c: RegistrarCredentials, http: Http, contact: DomainContact): Promise<string> {
  const r = await call(c, http, "AddContact", {
    firstname: contact.firstName,
    lastname: contact.lastName,
    organization: contact.organization,
    street0: contact.address,
    city: contact.city,
    state: contact.state,
    zip: contact.zip,
    country: contact.country,
    phone: contact.phone,
    email: contact.email,
  });
  const handle = r.props.contact?.[0];
  if (!handle) throw new RegistrarError("The contact could not be created");
  return handle;
}

const roles = (handle: string) => ({ ownercontact0: handle, admincontact0: handle, techcontact0: handle, billingcontact0: handle });

const itExtensions = (domain: string, contact: DomainContact): Record<string, string> =>
  domain.endsWith(".it") ? { "X-IT-PIN": contact.taxCode, "X-IT-ENTITY-TYPE": itEntityType(contact), "X-IT-NATIONALITY": contact.country, "X-IT-ACCEPT-LIABILITY-TAC": "1", "X-IT-ACCEPT-REGISTRATION-TAC": "1", "X-IT-ACCEPT-DIFFUSION-AND-ACCESSIBILITY-TAC": "1", "X-IT-ACCEPT-EXPLICIT-TAC": "1" } : {};

const date = (v: string | undefined) => {
  const d = v ? new Date(`${v.replace(" ", "T")}Z`) : null;
  return d && !Number.isNaN(d.getTime()) ? d : null;
};

export const centralnic: RegistrarModule = {
  id: "centralnic",
  name: "CentralNic Reseller",
  website: "https://www.centralnicreseller.com",
  fields: [
    { name: "login", label: "Login", type: "text", help: "Your reseller account, or a restricted sub-user created for this panel." },
    { name: "password", label: "Password", type: "password" },
  ],

  async test(c, http) {
    const r = await call(c, http, "StatusAccount");
    const amount = r.props.amount?.[0];
    return amount ? `Balance: ${amount} ${r.props.currency?.[0] ?? ""}`.trim() : "Connected";
  },

  async check(c, domains, http) {
    const r = await call(c, http, "CheckDomains", list("domain", domains));
    // Each entry reads like "210 Available" or "211 Domain name not available".
    return domains.map((domain, i) => ({ domain, available: (r.props.domaincheck?.[i] ?? "").startsWith("210") }));
  },

  async register(c, { domain, years, contact, nameservers }, http) {
    const handle = await contactHandle(c, http, contact);
    await call(c, http, "AddDomain", { domain, period: String(years), ...roles(handle), ...list("nameserver", nameservers), transferlock: "1", ...itExtensions(domain, contact) });
  },

  async transfer(c, { domain, authCode, contact, nameservers }, http) {
    const handle = await contactHandle(c, http, contact);
    await call(c, http, "TransferDomain", { domain, action: "request", auth: authCode, ...roles(handle), ...list("nameserver", nameservers), ...itExtensions(domain, contact) });
  },

  async renew(c, { domain, years, currentExpiry }, http) {
    // The expiry year guards against renewing twice when a call is retried.
    await call(c, http, "RenewDomain", { domain, period: String(years), ...(currentExpiry ? { expiration: String(currentExpiry.getUTCFullYear()) } : {}) });
  },

  async info(c, domain, http) {
    const r = await call(c, http, "StatusDomain", { domain });
    const status = (r.props.status ?? []).join(" ").toLowerCase();
    const expiresAt = date(r.props.registrationexpirationdate?.[0] ?? r.props.expirationdate?.[0]);
    return {
      status: status.includes("pendingtransfer") ? "transferring" : status.includes("pending") ? "pending" : expiresAt && expiresAt < new Date() ? "expired" : "active",
      expiresAt,
      nameservers: (r.props.nameserver ?? []).filter(Boolean).map((n) => n.toLowerCase()),
      locked: r.props.transferlock?.[0] === "1",
    };
  },

  async setNameservers(c, domain, nameservers, http) {
    await call(c, http, "ModifyDomain", { domain, ...list("nameserver", nameservers) });
  },

  async updateContact(c, domain, contact, http) {
    const handle = await contactHandle(c, http, contact);
    await call(c, http, "ModifyDomain", { domain, ...roles(handle), ...itExtensions(domain, contact) });
  },

  async setLock(c, domain, locked, http) {
    await call(c, http, "ModifyDomain", { domain, transferlock: locked ? "1" : "0" });
  },

  async authCode(c, domain, http) {
    const code = (await call(c, http, "StatusDomain", { domain })).props.auth?.[0] ?? "";
    if (!code) throw new RegistrarError("The registry did not return a transfer code for this domain");
    return code;
  },
};
