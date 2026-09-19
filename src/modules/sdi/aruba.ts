import { apiMessage, normalizeSdiStatus, readJson, SdiError, type Http, type SdiCredentials, type SdiProvider } from "./types";

/** Aruba Fatturazione Elettronica — https://fatturazioneelettronica.aruba.it/apidoc. OAuth password grant, XML uploaded as base64. */
const hosts = (c: SdiCredentials) => (c.sandbox === "1" ? { auth: "https://demoauth.fatturazioneelettronica.aruba.it", ws: "https://demows.fatturazioneelettronica.aruba.it" } : { auth: "https://auth.fatturazioneelettronica.aruba.it", ws: "https://ws.fatturazioneelettronica.aruba.it" });

async function token(c: SdiCredentials, http: Http): Promise<string> {
  const res = await http(`${hosts(c).auth}/auth/signin`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" }, body: new URLSearchParams({ grant_type: "password", username: c.username ?? "", password: c.password ?? "" }), signal: AbortSignal.timeout(30_000) });
  const json = await readJson(res);
  if (!res.ok || typeof json.access_token !== "string") throw new SdiError(apiMessage(json, "Aruba refused the credentials"));
  return json.access_token;
}

export const aruba: SdiProvider = {
  id: "aruba",
  name: "Aruba Fatturazione Elettronica",
  website: "https://www.aruba.it/fatturazione-elettronica.aspx",
  fields: [
    { name: "username", label: "Username", type: "text" },
    { name: "password", label: "Password", type: "password" },
  ],
  async send(c, doc, http) {
    const res = await http(`${hosts(c).ws}/services/invoice/upload`, { method: "POST", headers: { Authorization: `Bearer ${await token(c, http)}`, "Content-Type": "application/json;charset=UTF-8", Accept: "application/json" }, body: JSON.stringify({ dataFile: Buffer.from(doc.xml, "utf8").toString("base64"), credential: "", domain: "" }), signal: AbortSignal.timeout(60_000) });
    const json = await readJson(res);
    // Aruba answers 200 with an errorCode when it refuses the file.
    if (!res.ok || (json.errorCode && json.errorCode !== "0000") || typeof json.uploadFileName !== "string") throw new SdiError(apiMessage(json, `Aruba answered ${res.status}`));
    return { externalId: json.uploadFileName };
  },
  async status(c, id, http) {
    const res = await http(`${hosts(c).ws}/services/invoice/out/getByFilename?filename=${encodeURIComponent(id)}`, { headers: { Authorization: `Bearer ${await token(c, http)}`, Accept: "application/json" }, signal: AbortSignal.timeout(30_000) });
    const json = await readJson(res);
    if (!res.ok) throw new SdiError(apiMessage(json, `Aruba answered ${res.status}`));
    const invoice = (Array.isArray(json.invoices) ? json.invoices[0] : undefined) as { status?: unknown } | undefined;
    const raw = String(invoice?.status ?? json.status ?? "");
    return { status: normalizeSdiStatus(raw), message: raw };
  },
};
