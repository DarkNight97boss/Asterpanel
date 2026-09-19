import assert from "node:assert/strict";
import { test } from "node:test";
import { buildFatturaPa, fpaFilename, FpaError, splitVat, type FpaBuyer, type FpaInvoice, type FpaSeller } from "../src/lib/fatturapa";

const seller: FpaSeller = { name: "Aster Hosting S.r.l.", vatCountry: "IT", vatNumber: "01234567890", fiscalCode: "01234567890", regime: "RF01", address: "Via Roma 1", zip: "00100", city: "Roma", province: "rm", zeroVatNature: "N2.2", zeroVatNote: "Operazione in franchigia da IVA", iban: "IT60 X054 2811 1010 0000 0123 456" };
const buyer: FpaBuyer = { name: "Rossi & Figli <Web>", firstName: "Mario", lastName: "Rossi", isCompany: true, vatId: "IT 09876543210", taxCode: "", address: "Corso Italia 5", zip: "20100", city: "Milano", province: "mi", country: "IT", sdiCode: "abc1234", pec: "" };
const inv: FpaInvoice = { number: "INV-2026/0042", progressive: 2_600_042, date: new Date("2026-09-19T10:00:00Z"), dueDate: new Date("2026-10-19T10:00:00Z"), currency: "EUR", taxRateBp: 2200, subtotal: 1000, tax: 220, total: 1220, paid: true, paidBy: "transfer", lines: [{ description: "WP Starter — città “bella” € (mensile)", amount: 1000 }] };
const between = (xml: string, tag: string) => new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(xml)?.[1];

test("FatturaPA: an Italian company invoice carries the mandatory blocks, escaped and in Latin-1", () => {
  const xml = buildFatturaPa(seller, buyer, inv);
  assert.match(xml, /^<\?xml version="1.0" encoding="UTF-8"\?>\n<p:FatturaElettronica versione="FPR12"/);
  assert.equal(between(xml, "CodiceDestinatario"), "ABC1234");
  assert.equal(between(xml, "ProgressivoInvio"), "1JQ7E");
  assert.ok(xml.includes("<Denominazione>Rossi &amp; Figli &lt;Web&gt;</Denominazione>"));
  assert.ok(xml.includes("<IdFiscaleIVA><IdPaese>IT</IdPaese><IdCodice>09876543210</IdCodice></IdFiscaleIVA>"));
  assert.ok(xml.includes("<Descrizione>WP Starter - citta bella (mensile)</Descrizione>") || xml.includes("<Descrizione>WP Starter citta bella (mensile)</Descrizione>"), between(xml, "Descrizione"));
  assert.deepEqual([between(xml, "AliquotaIVA"), between(xml, "ImponibileImporto"), between(xml, "Imposta"), between(xml, "ImportoTotaleDocumento"), between(xml, "EsigibilitaIVA")], ["22.00", "10.00", "2.20", "12.20", "I"]);
  assert.deepEqual([between(xml, "Data"), between(xml, "Numero"), between(xml, "ModalitaPagamento"), between(xml, "IBAN")], ["2026-09-19", "INV-2026/0042", "MP05", "IT60X0542811101000000123456"]);
  assert.ok(!xml.includes("Natura"));
  assert.ok(xml.indexOf("<Provincia>RM</Provincia>") < xml.indexOf("<Provincia>MI</Provincia>"));
  assert.equal(fpaFilename(seller, inv.progressive), "IT01234567890_1JQ7E.xml");
});

test("FatturaPA: private people, foreign customers and 0% VAT follow their own rules", () => {
  const person = buildFatturaPa(seller, { ...buyer, isCompany: false, vatId: "", taxCode: "rssmra80a01h501u", sdiCode: "", pec: "mario@pec.example" }, { ...inv, paidBy: "card" });
  assert.deepEqual([between(person, "CodiceDestinatario"), between(person, "PECDestinatario"), between(person, "CodiceFiscale"), between(person, "ModalitaPagamento")], ["0000000", "mario@pec.example", "01234567890", "MP08"]);
  assert.ok(person.includes("<Nome>Mario</Nome><Cognome>Rossi</Cognome>") && person.includes("<CodiceFiscale>RSSMRA80A01H501U</CodiceFiscale>") && !person.includes("<IBAN>"));

  const foreign = buildFatturaPa(seller, { ...buyer, vatId: "DE123456789", country: "DE", zip: "10115 B", province: "Berlin", city: "Berlin" }, inv);
  assert.equal(between(foreign, "CodiceDestinatario"), "XXXXXXX");
  assert.ok(foreign.includes("<IdPaese>DE</IdPaese><IdCodice>123456789</IdCodice>") && foreign.includes("<CAP>00000</CAP><Comune>Berlin</Comune><Nazione>DE</Nazione>"));

  const flat = buildFatturaPa({ ...seller, regime: "RF19" }, buyer, { ...inv, taxRateBp: 0, tax: 0, total: 1000 });
  assert.deepEqual([between(flat, "AliquotaIVA"), between(flat, "Natura"), between(flat, "RiferimentoNormativo"), between(flat, "Causale")], ["0.00", "N2.2", "Operazione in franchigia da IVA", "Operazione in franchigia da IVA"]);
  assert.ok(!flat.includes("EsigibilitaIVA"));
});

test("FatturaPA: incomplete data is refused with a message staff can act on", () => {
  assert.throws(() => buildFatturaPa({ ...seller, vatNumber: "" }, buyer, inv), /seller details/);
  assert.throws(() => buildFatturaPa(seller, { ...buyer, vatId: "", taxCode: "" }, inv), /VAT number or a tax code/);
  assert.throws(() => buildFatturaPa(seller, { ...buyer, zip: "2010" }, inv), /5 digits/);
  assert.throws(() => buildFatturaPa(seller, { ...buyer, address: "" }, inv), /address is incomplete/);
  assert.throws(() => buildFatturaPa(seller, buyer, { ...inv, currency: "USD" }), FpaError);
  assert.deepEqual([splitVat("it 012.345", ""), splitVat("01234567890", ""), splitVat("", "IT")], [{ country: "IT", code: "012345" }, { country: "IT", code: "01234567890" }, null]);
});
