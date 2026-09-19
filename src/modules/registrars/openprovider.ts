import { RegistrarError, type DomainContact, type Http, type RegistrarCredentials, type RegistrarModule } from "./types";

/**
 * Openprovider — https://docs.openprovider.com (REST, JSON). A bearer token is
 * obtained with the reseller's user name and password and sent with each call.
 * Domains are addressed as { name, extension }.
 */

const base = (c: RegistrarCredentials) => (c.sandbox === "1" ? "https://api.cte.openprovider.eu/v1beta" : "https://api.openprovider.eu/v1beta");

type Json = Record<string, unknown>;

async function login(c: RegistrarCredentials, http: Http): Promise<string> {
  const res = await http(`${base(c)}/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: c.username ?? "", password: c.password ?? "" }), signal: AbortSignal.timeout(30_000) }).catch(() => null);
  const json = (await res?.json().catch(() => null)) as { data?: { token?: string }; desc?: string } | null;
  if (!res?.ok || !json?.data?.token) throw new RegistrarError(json?.desc || "Openprovider refused the credentials");
  return json.data.token;
}

async function call(c: RegistrarCredentials, http: Http, method: string, path: string, body?: Json): Promise<Json> {
  const token = await login(c, http);
  let res: Response;
  try {
    res = await http(`${base(c)}${path}`, { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(45_000) });
  } catch {
    throw new RegistrarError("Openprovider did not answer");
  }
  const json = (await res.json().catch(() => ({}))) as { code?: number; desc?: string; data?: Json };
  if (!res.ok || (json.code && json.code !== 0)) throw new RegistrarError(`${json.desc || `Openprovider answered ${res.status}`}${json.code ? ` (${json.code})` : ""}`.slice(0, 300));
  return json.data ?? {};
}

/** example.co.uk → { name: "example", extension: "co.uk" } */
const split = (domain: string) => ({ name: domain.slice(0, domain.indexOf(".")), extension: domain.slice(domain.indexOf(".") + 1) });

/** Openprovider keeps the domain's numeric id; everything after creation goes through it. */
async function domainId(c: RegistrarCredentials, http: Http, domain: string): Promise<number> {
  const { name, extension } = split(domain);
  const data = await call(c, http, "GET", `/domains?domain_name_pattern=${encodeURIComponent(name)}&extension=${encodeURIComponent(extension)}&limit=5`);
  const hit = ((data.results ?? []) as { id: number; domain: { name: string; extension: string } }[]).find((r) => r.domain.name === name && r.domain.extension === extension);
  if (!hit) throw new RegistrarError("This domain is not in the Openprovider account");
  return hit.id;
}

/** Contacts are "customers" with a handle; phone numbers are split into country code, area and subscriber. */
async function customerHandle(c: RegistrarCredentials, http: Http, contact: DomainContact): Promise<string> {
  const [cc, rest] = contact.phone.split(".");
  const data = await call(c, http, "POST", "/customers", {
    company_name: contact.organization,
    name: { first_name: contact.firstName, last_name: contact.lastName },
    email: contact.email,
    phone: { country_code: cc, area_code: rest.slice(0, 3), subscriber_number: rest.slice(3) },
    address: { street: contact.address, number: "", zipcode: contact.zip, city: contact.city, state: contact.state, country: contact.country },
    vat: contact.organization ? contact.taxCode : "",
    additional_data: contact.taxCode ? { social_security_number: contact.taxCode } : undefined,
  });
  const handle = String(data.handle ?? "");
  if (!handle) throw new RegistrarError("The contact could not be created");
  return handle;
}

const nsList = (nameservers: string[]) => nameservers.map((name, i) => ({ name, seq_nr: i + 1 }));

export const openprovider: RegistrarModule = {
  id: "openprovider",
  name: "Openprovider",
  website: "https://www.openprovider.com",
  fields: [
    { name: "username", label: "Username", type: "text" },
    { name: "password", label: "Password", type: "password" },
  ],

  async test(c, http) {
    const data = await call(c, http, "GET", "/resellers?limit=1");
    const reseller = ((data.results ?? []) as { balance?: number; company_name?: string }[])[0];
    return reseller?.balance != null ? `Balance: ${reseller.balance}` : "Connected";
  },

  async check(c, domains, http) {
    const data = await call(c, http, "POST", "/domains/check", { domains: domains.map(split), with_price: false });
    const results = (data.results ?? []) as { domain: string; status: string }[];
    return domains.map((domain) => ({ domain, available: results.find((r) => r.domain === domain)?.status === "free" }));
  },

  async register(c, { domain, years, contact, nameservers }, http) {
    const handle = await customerHandle(c, http, contact);
    await call(c, http, "POST", "/domains", { domain: split(domain), period: years, owner_handle: handle, admin_handle: handle, tech_handle: handle, billing_handle: handle, name_servers: nsList(nameservers), autorenew: "off", is_locked: true });
  },

  async transfer(c, { domain, authCode, contact, nameservers }, http) {
    const handle = await customerHandle(c, http, contact);
    await call(c, http, "POST", "/domains/transfer", { domain: split(domain), auth_code: authCode, owner_handle: handle, admin_handle: handle, tech_handle: handle, billing_handle: handle, name_servers: nsList(nameservers), autorenew: "off" });
  },

  async renew(c, { domain, years }, http) {
    await call(c, http, "POST", `/domains/${await domainId(c, http, domain)}/renew`, { domain: split(domain), period: years });
  },

  async info(c, domain, http) {
    const data = await call(c, http, "GET", `/domains/${await domainId(c, http, domain)}`);
    const status = String(data.status ?? "");
    const expires = data.expiration_date ? new Date(`${String(data.expiration_date).replace(" ", "T")}Z`) : null;
    return {
      status: status === "ACT" ? "active" : status === "REQ" || status === "SCH" ? "transferring" : status === "PEN" ? "pending" : status === "DEL" ? "expired" : "unknown",
      expiresAt: expires && !Number.isNaN(expires.getTime()) ? expires : null,
      nameservers: ((data.name_servers ?? []) as { name: string }[]).map((n) => n.name.toLowerCase()),
      locked: data.is_locked === true,
    };
  },

  async setNameservers(c, domain, nameservers, http) {
    await call(c, http, "PUT", `/domains/${await domainId(c, http, domain)}`, { name_servers: nsList(nameservers) });
  },

  async setLock(c, domain, locked, http) {
    await call(c, http, "PUT", `/domains/${await domainId(c, http, domain)}`, { is_locked: locked });
  },

  async setPrivacy(c, domain, enabled, http) {
    await call(c, http, "PUT", `/domains/${await domainId(c, http, domain)}`, { is_private_whois_enabled: enabled });
  },

  async updateContact(c, domain, contact, http) {
    const handle = await customerHandle(c, http, contact);
    await call(c, http, "PUT", `/domains/${await domainId(c, http, domain)}`, { owner_handle: handle, admin_handle: handle, tech_handle: handle, billing_handle: handle });
  },

  async authCode(c, domain, http) {
    const data = await call(c, http, "GET", `/domains/${await domainId(c, http, domain)}/authcode`);
    const code = String(data.auth_code ?? "");
    if (!code) throw new RegistrarError("The registry did not return a transfer code for this domain");
    return code;
  },
};
