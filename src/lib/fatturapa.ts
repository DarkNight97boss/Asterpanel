/**
 * FatturaPA 1.2.2 (FPR12) XML for one invoice — the format of the Italian
 * Sistema di Interscambio. Pure: data in, string out. Sending the file is the
 * job of an accredited intermediary; this produces what they accept.
 */

export type FpaSeller = { name: string; vatCountry: string; vatNumber: string; fiscalCode: string; regime: string; address: string; zip: string; city: string; province: string; zeroVatNature: string; zeroVatNote: string; iban: string; bollo?: boolean };
export type FpaBuyer = { name: string; firstName: string; lastName: string; isCompany: boolean; vatId: string; taxCode: string; address: string; zip: string; city: string; province: string; country: string; sdiCode: string; pec: string };
export type FpaInvoice = { number: string; progressive: number; date: Date; dueDate: Date; currency: string; taxRateBp: number; subtotal: number; tax: number; total: number; paid: boolean; paidBy: "card" | "transfer"; /** Set on credit notes: the invoice being reversed. */ credits?: { number: string; date: Date }; /** Why this particular invoice carries no VAT, when it is not the seller's general regime (e.g. EU reverse charge: N2.1). */ exemption?: { nature: string; note: string }; lines: { description: string; amount: number }[] };

export class FpaError extends Error {}

const esc = (v: string) => v.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]!);
/** The schema allows Latin-1 only: anything else is transliterated or dropped. */
const latin = (v: string, max: number) => esc(v.normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^\x20-\x7e -ÿ]/g, "").replace(/\s+/g, " ").trim().slice(0, max));
const money = (cents: number) => (cents / 100).toFixed(2);
const day = (d: Date) => d.toISOString().slice(0, 10);
const tag = (name: string, value: string | false | undefined | null) => (value ? `<${name}>${value}</${name}>` : "");

/** `IT01234567890` → country + code; bare Italian numbers are assumed IT. */
export function splitVat(vat: string, fallbackCountry: string): { country: string; code: string } | null {
  const v = vat.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!v) return null;
  const m = /^([A-Z]{2})(.+)$/.exec(v);
  return m ? { country: m[1], code: m[2] } : { country: fallbackCountry || "IT", code: v };
}

/** Progressive file id: up to 5 base-36 characters, unique per invoice. */
export const fpaFilename = (seller: Pick<FpaSeller, "vatCountry" | "vatNumber">, progressive: number) => `${seller.vatCountry}${seller.vatNumber}_${progressive.toString(36).toUpperCase().padStart(5, "0").slice(-5)}.xml`;

export function buildFatturaPa(seller: FpaSeller, buyer: FpaBuyer, inv: FpaInvoice): string {
  if (!seller.name || !seller.vatNumber || !seller.address || !seller.zip || !seller.city) throw new FpaError("Complete the seller details in the e-invoicing settings first");
  if (!/^RF(0[1-9]|1[0-9]|20)$/.test(seller.regime)) throw new FpaError("Invalid tax regime");
  if (inv.currency !== "EUR") throw new FpaError("Electronic invoices are issued in EUR");
  const italian = (buyer.country || "IT") === "IT";
  const vat = splitVat(buyer.vatId, buyer.country);
  if (italian && !vat && !buyer.taxCode) throw new FpaError("The customer needs a VAT number or a tax code (codice fiscale)");
  if (!buyer.address || !buyer.city) throw new FpaError("The customer's billing address is incomplete");
  if (italian && !/^\d{5}$/.test(buyer.zip)) throw new FpaError("The customer's postal code must have 5 digits");

  // Foreign customers: fixed recipient code and postal code, as the specification prescribes.
  const recipient = !italian ? "XXXXXXX" : /^[A-Z0-9]{7}$/i.test(buyer.sdiCode) ? buyer.sdiCode.toUpperCase() : "0000000";
  const rate = (inv.taxRateBp / 100).toFixed(2);
  const zeroVat = inv.taxRateBp === 0;
  const nature = inv.exemption?.nature ?? seller.zeroVatNature;
  const natureNote = inv.exemption?.note ?? seller.zeroVatNote;
  const who = (name: string, first: string, last: string, company: boolean) => (company || !last ? tag("Denominazione", latin(name, 80)) : tag("Nome", latin(first, 60)) + tag("Cognome", latin(last, 60)));

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<p:FatturaElettronica versione="FPR12" xmlns:ds="http://www.w3.org/2000/09/xmldsig#" xmlns:p="http://ivaservizi.agenziaentrate.gov.it/docs/xsd/fatture/v1.2" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">',
    "<FatturaElettronicaHeader>",
    "<DatiTrasmissione>",
    `<IdTrasmittente>${tag("IdPaese", seller.vatCountry)}${tag("IdCodice", latin(seller.fiscalCode || seller.vatNumber, 28))}</IdTrasmittente>`,
    tag("ProgressivoInvio", inv.progressive.toString(36).toUpperCase().padStart(5, "0").slice(-5)),
    tag("FormatoTrasmissione", "FPR12"),
    tag("CodiceDestinatario", recipient),
    recipient === "0000000" && tag("PECDestinatario", latin(buyer.pec, 256)),
    "</DatiTrasmissione>",
    "<CedentePrestatore>",
    "<DatiAnagrafici>",
    `<IdFiscaleIVA>${tag("IdPaese", seller.vatCountry)}${tag("IdCodice", latin(seller.vatNumber, 28))}</IdFiscaleIVA>`,
    tag("CodiceFiscale", latin(seller.fiscalCode, 16)),
    `<Anagrafica>${tag("Denominazione", latin(seller.name, 80))}</Anagrafica>`,
    tag("RegimeFiscale", seller.regime),
    "</DatiAnagrafici>",
    `<Sede>${tag("Indirizzo", latin(seller.address, 60))}${tag("CAP", seller.zip)}${tag("Comune", latin(seller.city, 60))}${tag("Provincia", latin(seller.province.toUpperCase(), 2))}${tag("Nazione", seller.vatCountry)}</Sede>`,
    "</CedentePrestatore>",
    "<CessionarioCommittente>",
    "<DatiAnagrafici>",
    vat && `<IdFiscaleIVA>${tag("IdPaese", vat.country)}${tag("IdCodice", latin(vat.code, 28))}</IdFiscaleIVA>`,
    italian && tag("CodiceFiscale", latin(buyer.taxCode.toUpperCase(), 16)),
    `<Anagrafica>${who(buyer.name, buyer.firstName, buyer.lastName, buyer.isCompany)}</Anagrafica>`,
    "</DatiAnagrafici>",
    `<Sede>${tag("Indirizzo", latin(buyer.address, 60))}${tag("CAP", italian ? buyer.zip : "00000")}${tag("Comune", latin(buyer.city, 60))}${italian ? tag("Provincia", latin(buyer.province.toUpperCase(), 2).replace(/[^A-Z]/g, "")) : ""}${tag("Nazione", buyer.country || "IT")}</Sede>`,
    "</CessionarioCommittente>",
    "</FatturaElettronicaHeader>",
    "<FatturaElettronicaBody>",
    "<DatiGenerali><DatiGeneraliDocumento>",
    tag("TipoDocumento", inv.credits ? "TD04" : "TD01"),
    tag("Divisa", "EUR"),
    tag("Data", day(inv.date)),
    tag("Numero", latin(inv.number, 20)),
    // Virtual stamp duty: invoices without VAT above EUR 77.47.
    seller.bollo && zeroVat && !inv.exemption && inv.total > 7747 && !inv.credits && `<DatiBollo>${tag("BolloVirtuale", "SI")}${tag("ImportoBollo", "2.00")}</DatiBollo>`,
    tag("ImportoTotaleDocumento", money(inv.total)),
    zeroVat && tag("Causale", latin(natureNote, 200)),
    "</DatiGeneraliDocumento>",
    inv.credits && `<DatiFattureCollegate>${tag("IdDocumento", latin(inv.credits.number, 20))}${tag("Data", day(inv.credits.date))}</DatiFattureCollegate>`,
    "</DatiGenerali>",
    "<DatiBeniServizi>",
    ...inv.lines.map((l, i) => `<DettaglioLinee>${tag("NumeroLinea", String(i + 1))}${tag("Descrizione", latin(l.description, 1000) || "-")}${tag("Quantita", "1.00")}${tag("PrezzoUnitario", money(l.amount))}${tag("PrezzoTotale", money(l.amount))}${tag("AliquotaIVA", rate)}${zeroVat ? tag("Natura", nature) : ""}</DettaglioLinee>`),
    `<DatiRiepilogo>${tag("AliquotaIVA", rate)}${zeroVat ? tag("Natura", nature) : ""}${tag("ImponibileImporto", money(inv.subtotal))}${tag("Imposta", money(inv.tax))}${zeroVat ? tag("RiferimentoNormativo", latin(natureNote, 100)) : tag("EsigibilitaIVA", "I")}</DatiRiepilogo>`,
    "</DatiBeniServizi>",
    `<DatiPagamento>${tag("CondizioniPagamento", "TP02")}<DettaglioPagamento>${tag("ModalitaPagamento", inv.paidBy === "card" ? "MP08" : "MP05")}${tag("DataScadenzaPagamento", day(inv.dueDate))}${tag("ImportoPagamento", money(inv.total))}${inv.paidBy === "transfer" ? tag("IBAN", seller.iban.replace(/\s/g, "").toUpperCase()) : ""}</DettaglioPagamento></DatiPagamento>`,
    "</FatturaElettronicaBody>",
    "</p:FatturaElettronica>",
  ]
    .filter(Boolean)
    .join("\n");
}
