import "server-only";
import type { ImportBundle } from "./import";
import { publicHttpsUrl } from "./net";

/**
 * Reads customers, services and domains from a WHMCS installation through its
 * API (api.php, with an API credential: identifier + secret) and turns them
 * into an import bundle. Read-only: only Get* actions are called.
 */

type Http = typeof fetch;
let http: Http = (...args) => fetch(...args);
export const setWhmcsHttpForTests = (fake: Http) => void (http = fake);

export class WhmcsError extends Error {}
export type WhmcsAccess = { url: string; identifier: string; secret: string };

const PAGE = 250;
type Row = Record<string, unknown>;
const cents = (v: unknown) => Math.round(Number(String(v ?? "0").replace(",", ".")) * 100) || 0;
const str = (v: unknown) => (v === null || v === undefined ? "" : String(v));

async function call(access: WhmcsAccess, action: string, params: Record<string, string | number> = {}): Promise<Row> {
  const base = publicHttpsUrl(access.url.replace(/\/+$/, "").replace(/\/includes\/api\.php$/i, ""));
  if (!base) throw new WhmcsError("Enter the https:// address of your WHMCS");
  const body = new URLSearchParams({ identifier: access.identifier, secret: access.secret, action, responsetype: "json", ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])) });
  const res = await http(`${base.href.replace(/\/+$/, "")}/includes/api.php`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: body.toString(), signal: AbortSignal.timeout(60_000) }).catch(() => null);
  if (!res) throw new WhmcsError("WHMCS could not be reached");
  const json = (await res.json().catch(() => null)) as Row | null;
  if (!json) throw new WhmcsError(`WHMCS did not answer with JSON (HTTP ${res.status}): check the address, and that this server's IP is allowed in WHMCS → General Settings → Security → API IP Access Restriction`);
  if (json.result !== "success") throw new WhmcsError(`WHMCS: ${str(json.message).slice(0, 200) || "request refused"}`);
  return json;
}

/** Walks a paged list: `container.item` holds the rows, `totalresults` how many there are. */
async function all(access: WhmcsAccess, action: string, container: string, item: string, params: Record<string, string | number> = {}): Promise<Row[]> {
  const rows: Row[] = [];
  for (let start = 0; start < 500_000; start += PAGE) {
    const json = await call(access, action, { ...params, limitstart: start, limitnum: PAGE });
    const holder = json[container] as Row | undefined;
    const page = holder && Array.isArray(holder[item]) ? (holder[item] as Row[]) : [];
    rows.push(...page);
    if (page.length < PAGE || rows.length >= Number(json.totalresults ?? 0)) break;
  }
  return rows;
}

export async function testWhmcs(access: WhmcsAccess): Promise<number> {
  return Number((await call(access, "GetClients", { limitnum: 1 })).totalresults ?? 0);
}

export async function fetchWhmcsBundle(access: WhmcsAccess): Promise<ImportBundle> {
  const clients = [];
  for (const c of await all(access, "GetClients", "clients", "client")) {
    // The list has names and emails; the address is only in the details.
    const details = await call(access, "GetClientsDetails", { clientid: str(c.id), stats: "false" }).catch(() => ({}) as Row);
    const d = (details.client ?? details) as Row;
    clients.push({ ref: str(c.id), email: str(c.email), firstName: str(c.firstname), lastName: str(c.lastname), company: str(c.companyname), vatId: str(d.tax_id), phone: str(d.phonenumber), address: [str(d.address1), str(d.address2)].filter(Boolean).join(", "), city: str(d.city), zip: str(d.postcode), state: str(d.state), country: str(d.countrycode ?? d.country), active: str(c.status).toLowerCase() !== "closed" });
  }
  const services = (await all(access, "GetClientsProducts", "products", "product")).map((p) => ({ ref: str(p.id), clientRef: str(p.clientid), product: str(p.name) || str(p.translated_name), domain: str(p.domain), cycle: str(p.billingcycle), amount: cents(p.recurringamount), nextDueDate: str(p.nextduedate), createdAt: str(p.regdate), status: str(p.status) }));
  const domains = (await all(access, "GetClientsDomains", "domains", "domain")).map((d) => ({ ref: str(d.id), clientRef: str(d.userid), name: str(d.domainname), registrar: str(d.registrar), amount: cents(d.recurringamount), expiresAt: str(d.expirydate), nextDueDate: str(d.nextduedate), status: str(d.status) }));
  return { source: "whmcs", clients, services, domains };
}
