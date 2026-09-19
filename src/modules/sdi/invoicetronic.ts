import { apiMessage, normalizeSdiStatus, readJson, SdiError, type SdiCredentials, type SdiProvider } from "./types";

/** Invoicetronic — https://invoicetronic.com/docs. API key as Basic user; test keys select the sandbox by themselves. */
const BASE = "https://api.invoicetronic.com/v1";
const auth = (c: SdiCredentials) => `Basic ${Buffer.from(`${c.apiKey}:`).toString("base64")}`;

export const invoicetronic: SdiProvider = {
  id: "invoicetronic",
  name: "Invoicetronic",
  website: "https://invoicetronic.com",
  fields: [{ name: "apiKey", label: "API key", type: "password", help: "A test key (ik_test_…) sends nothing to the real SDI." }],
  async send(c, doc, http) {
    const res = await http(`${BASE}/send/xml`, { method: "POST", headers: { Authorization: auth(c), "Content-Type": "application/xml" }, body: doc.xml, signal: AbortSignal.timeout(60_000) });
    const json = await readJson(res);
    if (!res.ok || json.id === undefined) throw new SdiError(apiMessage(json, `Invoicetronic answered ${res.status}`));
    return { externalId: String(json.id) };
  },
  async status(c, id, http) {
    const res = await http(`${BASE}/update?send_id=${encodeURIComponent(id)}&sort=-last_update&page_size=1`, { headers: { Authorization: auth(c) }, signal: AbortSignal.timeout(30_000) });
    const body = (await res.json().catch(() => [])) as unknown;
    if (!res.ok) throw new SdiError(apiMessage((body ?? {}) as Record<string, unknown>, `Invoicetronic answered ${res.status}`));
    const last = (Array.isArray(body) ? body[0] : undefined) as { state?: unknown; description?: unknown } | undefined;
    const raw = String(last?.state ?? "");
    return { status: normalizeSdiStatus(raw), message: String(last?.description ?? raw) };
  },
};
