import { apiMessage, normalizeSdiStatus, readJson, SdiError, type SdiCredentials, type SdiProvider } from "./types";

/** Openapi.com SDI — https://console.openapi.com/apis/sdi. Bearer token, XML posted as is. */
const base = (c: SdiCredentials) => (c.sandbox === "1" ? "https://test.sdi.openapi.it" : "https://sdi.openapi.it");

export const openapi: SdiProvider = {
  id: "openapi",
  name: "Openapi SDI",
  website: "https://openapi.com",
  fields: [{ name: "token", label: "API token", type: "password" }],
  async send(c, doc, http) {
    const res = await http(`${base(c)}/invoices`, { method: "POST", headers: { Authorization: `Bearer ${c.token}`, "Content-Type": "application/xml" }, body: doc.xml, signal: AbortSignal.timeout(60_000) });
    const json = await readJson(res);
    const uuid = (json.data as { uuid?: unknown } | undefined)?.uuid;
    if (!res.ok || typeof uuid !== "string") throw new SdiError(apiMessage(json, `Openapi answered ${res.status}`));
    return { externalId: uuid };
  },
  async status(c, id, http) {
    const res = await http(`${base(c)}/invoices/${encodeURIComponent(id)}`, { headers: { Authorization: `Bearer ${c.token}` }, signal: AbortSignal.timeout(30_000) });
    const json = await readJson(res);
    if (!res.ok) throw new SdiError(apiMessage(json, `Openapi answered ${res.status}`));
    const raw = String((json.data as { marking?: unknown; status?: unknown } | undefined)?.marking ?? (json.data as { status?: unknown } | undefined)?.status ?? "");
    return { status: normalizeSdiStatus(raw), message: raw };
  },
};
