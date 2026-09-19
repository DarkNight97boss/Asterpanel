import { apiMessage, normalizeSdiStatus, readJson, SdiError, type Http, type SdiCredentials, type SdiProvider } from "./types";

/**
 * Fatture in Cloud (API v2) — https://developers.fattureincloud.it. It does not
 * take a ready XML: the invoice is re-created there as an issued document and
 * Fatture in Cloud builds and sends the e-invoice, numbering included.
 */
const BASE = "https://api-v2.fattureincloud.it";

async function call(c: SdiCredentials, http: Http, method: string, path: string, body?: unknown): Promise<Record<string, unknown>> {
  if (!/^\d+$/.test(c.companyId ?? "")) throw new SdiError("The Fatture in Cloud company id must be a number");
  const res = await http(`${BASE}/c/${c.companyId}${path}`, { method, headers: { Authorization: `Bearer ${c.token}`, "Content-Type": "application/json", Accept: "application/json" }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(60_000) });
  const json = await readJson(res);
  if (!res.ok) throw new SdiError(apiMessage((json.error as Record<string, unknown>) ?? json, `Fatture in Cloud answered ${res.status}`));
  return json;
}

export const fattureincloud: SdiProvider = {
  id: "fattureincloud",
  name: "Fatture in Cloud",
  website: "https://www.fattureincloud.it",
  fields: [
    { name: "token", label: "Access token", type: "password" },
    { name: "companyId", label: "Company ID", type: "text", help: "The number in the address of your Fatture in Cloud account." },
  ],
  async send(c, doc, http) {
    const d = doc.data;
    // VAT types are per account: find the one with this invoice's rate.
    const vats = ((await call(c, http, "GET", "/info/vat_types")).data ?? []) as { id: number; value: number; is_disabled?: boolean }[];
    const vat = vats.find((v) => !v.is_disabled && Number(v.value) === d.taxRatePercent);
    if (!vat) throw new SdiError(`No VAT type of ${d.taxRatePercent}% exists in the Fatture in Cloud account`);
    const created = await call(c, http, "POST", "/issued_documents", {
      data: {
        type: d.isCreditNote ? "credit_note" : "invoice",
        e_invoice: true,
        date: d.date,
        currency: { id: d.currency },
        notes: d.number,
        entity: { name: d.buyer.name, vat_number: d.buyer.vatNumber, tax_code: d.buyer.taxCode, address_street: d.buyer.address, address_postal_code: d.buyer.zip, address_city: d.buyer.city, address_province: d.buyer.province, country_iso: d.buyer.country, ei_code: d.buyer.sdiCode || "0000000", certified_email: d.buyer.pec },
        items_list: d.lines.map((l) => ({ name: l.description.slice(0, 500), qty: 1, net_price: l.amount / 100, vat: { id: vat.id } })),
        payments_list: [{ amount: d.total / 100, due_date: d.dueDate, status: "not_paid" }],
        ei_data: { payment_method: "MP05" },
      },
    });
    const id = (created.data as { id?: unknown } | undefined)?.id;
    if (id === undefined) throw new SdiError("Fatture in Cloud did not return the document");
    await call(c, http, "POST", `/issued_documents/${id}/e_invoice/send`, { data: {} });
    return { externalId: String(id) };
  },
  async status(c, id, http) {
    if (!/^\d+$/.test(id)) throw new SdiError("Invalid document id");
    const doc = ((await call(c, http, "GET", `/issued_documents/${id}?fields=ei_status`)).data ?? {}) as { ei_status?: unknown };
    const raw = String(doc.ei_status ?? "");
    return { status: normalizeSdiStatus(raw === "sent" || raw === "processing" || raw === "attempt" ? "" : raw), message: raw };
  },
};
