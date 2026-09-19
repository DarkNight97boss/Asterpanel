import { itEntityType, RegistrarError, type DomainContact, type Http, type RegistrarCredentials, type RegistrarModule } from "./types";

/**
 * Internet.bs reseller API — https://internetbs.net/ResellerRegistrarDomainNameAPI
 * Form-encoded POST, JSON answers with a `status` of SUCCESS / PENDING / FAILURE
 * (AVAILABLE / UNAVAILABLE for checks).
 */

const base = (c: RegistrarCredentials) => (c.sandbox === "1" ? "https://testapi.internetbs.net" : "https://api.internetbs.net");

async function call(c: RegistrarCredentials, http: Http, path: string, params: Record<string, string>): Promise<Record<string, unknown>> {
  const body = new URLSearchParams({ ApiKey: c.apiKey ?? "", Password: c.password ?? "", ResponseFormat: "JSON", ...params });
  let res: Response;
  try {
    res = await http(`${base(c)}${path}`, { method: "POST", body, headers: { "Content-Type": "application/x-www-form-urlencoded" }, signal: AbortSignal.timeout(45_000) });
  } catch {
    throw new RegistrarError("Internet.bs did not answer");
  }
  const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!json) throw new RegistrarError(`Internet.bs answered with HTTP ${res.status}`);
  if (json.status === "FAILURE") throw new RegistrarError(String(json.message ?? "Request refused").slice(0, 300));
  return json;
}

const ROLES = ["Registrant", "Admin", "Technical", "Billing"] as const;

function contactParams(contact: DomainContact, domain: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const role of ROLES) {
    Object.assign(out, {
      [`${role}_FirstName`]: contact.firstName,
      [`${role}_LastName`]: contact.lastName,
      [`${role}_Organization`]: contact.organization,
      [`${role}_Email`]: contact.email,
      [`${role}_PhoneNumber`]: contact.phone,
      [`${role}_Street`]: contact.address,
      [`${role}_City`]: contact.city,
      [`${role}_PostalCode`]: contact.zip,
      [`${role}_CountryCode`]: contact.country,
    });
    // .it: the registry wants the entity type, nationality and fiscal code of registrant and admin.
    if (domain.endsWith(".it") && (role === "Registrant" || role === "Admin")) {
      Object.assign(out, { [`${role}_dotitEntityType`]: itEntityType(contact), [`${role}_dotitNationality`]: contact.country, [`${role}_dotitRegCode`]: contact.taxCode });
    }
  }
  return out;
}

const date = (v: unknown) => {
  const d = new Date(String(v ?? "").replace(/\//g, "-"));
  return Number.isNaN(d.getTime()) ? null : d;
};

export const internetbs: RegistrarModule = {
  id: "internetbs",
  name: "Internet.bs",
  website: "https://internetbs.net",
  fields: [
    { name: "apiKey", label: "API key", type: "text" },
    { name: "password", label: "API password", type: "password" },
  ],

  async test(c, http) {
    const r = await call(c, http, "/Account/Balance/Get", {});
    const balances = Array.isArray(r.balance) ? (r.balance as { amount?: unknown; currency?: unknown }[]).map((b) => `${b.amount} ${b.currency}`).join(", ") : "";
    return balances ? `Balance: ${balances}` : "Connected";
  },

  async check(c, domains, http) {
    return Promise.all(domains.map(async (domain) => ({ domain, available: (await call(c, http, "/Domain/Check", { Domain: domain })).status === "AVAILABLE" })));
  },

  async register(c, { domain, years, contact, nameservers }, http) {
    await call(c, http, "/Domain/Create", { Domain: domain, Period: `${years}Y`, Ns_list: nameservers.join(","), ...contactParams(contact, domain) });
  },

  async transfer(c, { domain, authCode, contact, nameservers }, http) {
    await call(c, http, "/Domain/Transfer/Initiate", { Domain: domain, transferAuthInfo: authCode, Ns_list: nameservers.join(","), ...contactParams(contact, domain) });
  },

  async renew(c, { domain, years }, http) {
    await call(c, http, "/Domain/Renew", { Domain: domain, Period: `${years}Y` });
  },

  async info(c, domain, http) {
    const r = await call(c, http, "/Domain/Info", { Domain: domain });
    const state = String(r.domainstatus ?? "").toUpperCase();
    return {
      status: state === "REGISTERED" ? "active" : state === "EXPIRED" ? "expired" : state.includes("TRANSFER") ? "transferring" : state.includes("PENDING") ? "pending" : "unknown",
      expiresAt: date(r.expirationdate),
      nameservers: (Array.isArray(r.nameserver) ? r.nameserver : []).map((n) => String(n).toLowerCase()),
      locked: String(r.registrarlock ?? "").toUpperCase() === "ENABLED",
    };
  },

  async setNameservers(c, domain, nameservers, http) {
    await call(c, http, "/Domain/Update", { Domain: domain, Ns_list: nameservers.join(",") });
  },

  async setLock(c, domain, locked, http) {
    await call(c, http, `/Domain/RegistrarLock/${locked ? "Enable" : "Disable"}`, { Domain: domain });
  },

  async authCode(c, domain, http) {
    const code = String((await call(c, http, "/Domain/Info", { Domain: domain })).transferauthinfo ?? "");
    if (!code) throw new RegistrarError("The registry did not return a transfer code for this domain");
    return code;
  },
};
