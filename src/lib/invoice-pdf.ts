import "server-only";
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage, type RGB } from "pdf-lib";
import { makeT } from "@/i18n/shared";
import { displayName, formatDate, formatMoney, invoiceLabel } from "./format";
import type { LoadedInvoice } from "./invoices";
import { getSettings } from "./settings";

/**
 * Invoice → PDF (A4). Pure JavaScript, no headless browser and no font files:
 * it uses the PDF standard fonts, which cover Western European text. Anything
 * outside that range is transliterated by `encodable()` rather than crashing.
 */

const A4 = { width: 595.28, height: 841.89 };
const MARGIN = 48;
const RIGHT = A4.width - MARGIN;
const INK = rgb(0.06, 0.09, 0.16);
const MUTED = rgb(0.36, 0.4, 0.47);
const RULE = rgb(0.89, 0.9, 0.93);

const STATUS: Record<string, { label: string; color: RGB }> = {
  paid: { label: "Paid", color: rgb(0.08, 0.5, 0.24) },
  unpaid: { label: "Unpaid", color: rgb(0.71, 0.33, 0.04) },
  cancelled: { label: "Cancelled", color: MUTED },
  refunded: { label: "Refunded", color: MUTED },
  draft: { label: "Draft", color: MUTED },
};

function hexToRgb(hex: string): RGB {
  const n = parseInt(hex.slice(1), 16);
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

const REPLACEMENTS: [RegExp, string][] = [
  [/[\u2190-\u21ff]/g, "-"], // arrows
  // Spaces emitted by Intl formatting. NBSP is encodable but measured as zero
  // width by the standard fonts, which breaks right alignment.
  [/[\u00a0\u2000-\u200a\u202f\u205f]/g, " "],
  [/[\u200b-\u200f\ufeff]/g, ""],
];

/** Makes a string drawable with a WinAnsi standard font. */
function encodable(font: PDFFont, input: string): string {
  let text = input.normalize("NFC");
  for (const [re, to] of REPLACEMENTS) text = text.replace(re, to);
  const supported = new Set(font.getCharacterSet());
  let out = "";
  for (const ch of text) {
    if (supported.has(ch.codePointAt(0)!)) out += ch;
    else {
      const base = ch.normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
      out += [...base].every((b) => supported.has(b.codePointAt(0)!)) && base ? base : "?";
    }
  }
  return out;
}

export async function renderInvoicePdf(invoice: LoadedInvoice): Promise<{ filename: string; bytes: Uint8Array }> {
  const [general, billing, theme] = await Promise.all([getSettings("general"), getSettings("billing"), getSettings("theme")]);
  const t = makeT(general.locale);
  const locale = general.locale;
  const number = invoiceLabel(billing.invoicePrefix, invoice);
  const money = (cents: number) => formatMoney(cents, invoice.currency, locale);
  const brand = hexToRgb(theme.primary);

  const pdf = await PDFDocument.create();
  pdf.setTitle(`${t(invoice.kind === "credit_note" ? "Credit note" : "Invoice")} ${number}`);
  pdf.setAuthor(general.companyName || general.siteName);
  pdf.setCreator("AsterPanel");
  pdf.setCreationDate(invoice.createdAt);

  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);

  let page: PDFPage = pdf.addPage([A4.width, A4.height]);
  let y = A4.height - MARGIN;

  type Opts = { font?: PDFFont; size?: number; color?: RGB; align?: "left" | "right" };
  const draw = (raw: string, x: number, atY: number, { font = regular, size = 10, color = INK, align = "left" }: Opts = {}) => {
    const text = encodable(font, raw);
    page.drawText(text, { x: align === "right" ? x - font.widthOfTextAtSize(text, size) : x, y: atY, size, font, color });
  };
  const wrap = (raw: string, maxWidth: number, font = regular, size = 10): string[] => {
    const lines: string[] = [];
    for (const paragraph of encodable(font, raw).split(/\r?\n/)) {
      let line = "";
      for (const word of paragraph.split(/\s+/).filter(Boolean)) {
        const candidate = line ? `${line} ${word}` : word;
        if (line && font.widthOfTextAtSize(candidate, size) > maxWidth) {
          lines.push(line);
          line = word;
        } else line = candidate;
      }
      lines.push(line);
    }
    return lines;
  };
  const rule = (atY: number, color = RULE) =>
    page.drawLine({ start: { x: MARGIN, y: atY }, end: { x: RIGHT, y: atY }, thickness: 0.75, color });
  /** Starts a new page when fewer than `space` points are left. */
  const ensure = (space: number) => {
    if (y - space > MARGIN + 30) return;
    page = pdf.addPage([A4.width, A4.height]);
    y = A4.height - MARGIN;
  };

  // ── Header ────────────────────────────────────────────────────────────────
  draw(general.companyName || general.siteName, MARGIN, y - 14, { font: bold, size: 18, color: brand });
  draw(`${t(invoice.kind === "credit_note" ? "Credit note" : "Invoice")} ${number}`, RIGHT, y - 12, { font: bold, size: 15, align: "right" });
  const status = STATUS[invoice.status] ?? STATUS.draft;
  draw(t(status.label).toUpperCase(), RIGHT, y - 28, { font: bold, size: 9, color: status.color, align: "right" });
  y -= 48;
  page.drawRectangle({ x: MARGIN, y, width: RIGHT - MARGIN, height: 2, color: brand });
  y -= 28;

  // ── Parties & dates ───────────────────────────────────────────────────────
  const c = invoice.client;
  const from = [
    general.companyName || general.siteName,
    ...general.companyAddress.split(/\r?\n/),
    general.companyVatId && `${billing.taxName}: ${general.companyVatId}`,
  ];
  const to = [
    c.company || displayName(c),
    c.company && displayName(c),
    c.address,
    [c.zip, c.city, c.state].filter(Boolean).join(" "),
    c.country,
    c.vatId && `${billing.taxName}: ${c.vatId}`,
    c.taxCode && `${t("Tax code")}: ${c.taxCode}`,
    c.email,
  ];
  const dates: [string, string][] = [
    [t("Issued"), formatDate(invoice.createdAt, locale)],
    [t("Due"), formatDate(invoice.dueDate, locale)],
    ...(invoice.paidAt ? [[t("Paid on"), formatDate(invoice.paidAt, locale)] as [string, string]] : []),
  ];

  const colWidth = 165;
  const column = (title: string, lines: (string | false)[], x: number) => {
    draw(title.toUpperCase(), x, y, { font: bold, size: 8, color: MUTED });
    let cy = y - 15;
    lines.filter((l): l is string => !!l).forEach((line, i) => {
      for (const part of wrap(line, colWidth, i === 0 ? bold : regular)) {
        draw(part, x, cy, { font: i === 0 ? bold : regular, color: i === 0 ? INK : MUTED });
        cy -= 13;
      }
    });
    return cy;
  };
  const bottoms = [column(t("From"), from, MARGIN), column(t("Billed to"), to, MARGIN + colWidth + 20)];
  let dy = y;
  for (const [label, value] of dates) {
    draw(label, RIGHT - 95, dy, { color: MUTED, align: "right" });
    draw(value, RIGHT, dy, { align: "right" });
    dy -= 15;
  }
  y = Math.min(...bottoms, dy) - 22;

  // ── Items ─────────────────────────────────────────────────────────────────
  const tableHead = () => {
    draw(t("Description").toUpperCase(), MARGIN, y, { font: bold, size: 8, color: MUTED });
    draw(t("Amount").toUpperCase(), RIGHT, y, { font: bold, size: 8, color: MUTED, align: "right" });
    y -= 8;
    rule(y);
    y -= 16;
  };
  tableHead();
  for (const item of invoice.items) {
    const lines = wrap(item.description, RIGHT - MARGIN - 110);
    if (y - lines.length * 13 - 10 <= MARGIN + 30) {
      ensure(Infinity);
      tableHead();
    }
    draw(money(item.amount), RIGHT, y, { align: "right" });
    for (const line of lines) {
      draw(line, MARGIN, y);
      y -= 13;
    }
    y -= 5;
    rule(y + 4);
    y -= 10;
  }

  // ── Totals ────────────────────────────────────────────────────────────────
  ensure(90);
  const total = (label: string, value: string, strong = false) => {
    draw(label, RIGHT - 110, y, { align: "right", color: strong ? INK : MUTED, font: strong ? bold : regular, size: strong ? 12 : 10 });
    draw(value, RIGHT, y, { align: "right", font: strong ? bold : regular, size: strong ? 12 : 10 });
    y -= strong ? 22 : 16;
  };
  y -= 4;
  total(t("Subtotal"), money(invoice.subtotal));
  if (invoice.taxRate > 0) total(`${billing.taxName} ${invoice.taxRate / 100}%`, money(invoice.tax));
  y -= 2;
  total(t("Total"), money(invoice.total), true);

  // ── Payments & notes ──────────────────────────────────────────────────────
  if (invoice.transactions.length) {
    ensure(40 + invoice.transactions.length * 14);
    y -= 8;
    draw(t("Payments").toUpperCase(), MARGIN, y, { font: bold, size: 8, color: MUTED });
    y -= 15;
    for (const tx of invoice.transactions) {
      draw(`${formatDate(tx.createdAt, locale)} · ${tx.gateway}${tx.externalId ? ` · ${tx.externalId}` : ""}`, MARGIN, y, { color: MUTED, size: 9 });
      draw(money(tx.amount), RIGHT, y, { color: MUTED, size: 9, align: "right" });
      y -= 14;
    }
  }

  const notes = [invoice.notes, invoice.status === "unpaid" ? billing.bankTransferInstructions : ""].filter(Boolean).join("\n\n");
  if (notes) {
    const lines = wrap(notes, RIGHT - MARGIN, regular, 9);
    ensure(30 + lines.length * 12);
    y -= 14;
    for (const line of lines) {
      ensure(12);
      draw(line, MARGIN, y, { size: 9, color: MUTED });
      y -= 12;
    }
  }

  // ── Footer on every page ──────────────────────────────────────────────────
  const pages = pdf.getPages();
  pages.forEach((p, i) => {
    page = p;
    rule(MARGIN + 14);
    draw([general.companyName || general.siteName, general.supportEmail].filter(Boolean).join(" · "), MARGIN, MARGIN, { size: 8, color: MUTED });
    draw(`${number} · ${i + 1}/${pages.length}`, RIGHT, MARGIN, { size: 8, color: MUTED, align: "right" });
  });

  return { filename: `${number.replace(/[^\w.-]+/g, "_")}.pdf`, bytes: await pdf.save() };
}
