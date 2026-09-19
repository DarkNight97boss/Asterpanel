import { apiMessage, normalizeSdiStatus, readJson, SdiError, type Http, type SdiCredentials, type SdiProvider } from "./types";

/** A-Cube API — https://docs.acubeapi.com. JWT from /login, then the XML is posted as is. */
const hosts = (c: SdiCredentials) => (c.sandbox === "1" ? { auth: "https://common-sandbox.api.acubeapi.com", api: "https://api-sandbox.acubeapi.com" } : { auth: "https://common.api.acubeapi.com", api: "https://api.acubeapi.com" });

async function token(c: SdiCredentials, http: Http): Promise<string> {
  const res = await http(`${hosts(c).auth}/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: c.email, password: c.password }), signal: AbortSignal.timeout(30_000) });
  const json = await readJson(res);
  if (!res.ok || typeof json.token !== "string") throw new SdiError(apiMessage(json, "A-Cube refused the credentials"));
  return json.token;
}

export const acube: SdiProvider = {
  id: "acube",
  name: "A-Cube API",
  website: "https://acubeapi.com",
  fields: [
    { name: "email", label: "Email", type: "text" },
    { name: "password", label: "Password", type: "password" },
  ],
  async send(c, doc, http) {
    const res = await http(`${hosts(c).api}/invoices`, { method: "POST", headers: { Authorization: `Bearer ${await token(c, http)}`, "Content-Type": "application/xml" }, body: doc.xml, signal: AbortSignal.timeout(60_000) });
    const json = await readJson(res);
    if (!res.ok || typeof json.uuid !== "string") throw new SdiError(apiMessage(json, `A-Cube answered ${res.status}`));
    return { externalId: json.uuid };
  },
  async status(c, id, http) {
    const res = await http(`${hosts(c).api}/invoices/${encodeURIComponent(id)}`, { headers: { Authorization: `Bearer ${await token(c, http)}`, Accept: "application/json" }, signal: AbortSignal.timeout(30_000) });
    const json = await readJson(res);
    if (!res.ok) throw new SdiError(apiMessage(json, `A-Cube answered ${res.status}`));
    const raw = String(json.marking ?? json.status ?? "");
    return { status: normalizeSdiStatus(raw), message: raw };
  },
};
