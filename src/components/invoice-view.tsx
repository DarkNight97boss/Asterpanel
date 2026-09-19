import { getLocale, getT } from "@/i18n";
import { displayName } from "@/lib/auth";
import { formatDate, formatMoney, invoiceLabel } from "@/lib/format";
import type { LoadedInvoice } from "@/lib/invoices";
import { getSettings } from "@/lib/settings";
import { Card, StatusBadge, STATUS_LABEL } from "./ui";

/** The printable invoice document, shared by the client area and the admin. */
export async function InvoiceView({ invoice }: { invoice: LoadedInvoice }) {
  const [t, locale, general, billing] = await Promise.all([getT(), getLocale(), getSettings("general"), getSettings("billing")]);
  const money = (cents: number) => formatMoney(cents, invoice.currency, locale);
  const c = invoice.client;

  return (
    <Card className="p-6 sm:p-10">
      <div className="flex flex-wrap items-start justify-between gap-6">
        <div>
          <p className="text-2xl font-bold tracking-tight">
            {t("Invoice")} {invoiceLabel(billing.invoicePrefix, invoice)}
          </p>
          <div className="mt-2">
            <StatusBadge status={invoice.status} label={t(STATUS_LABEL[invoice.status])} />
          </div>
        </div>
        <dl className="grid grid-cols-[auto_auto] gap-x-6 gap-y-1 text-sm">
          <dt className="text-muted">{t("Issued")}</dt>
          <dd className="text-right">{formatDate(invoice.createdAt, locale)}</dd>
          <dt className="text-muted">{t("Due")}</dt>
          <dd className="text-right">{formatDate(invoice.dueDate, locale)}</dd>
          {invoice.paidAt && (
            <>
              <dt className="text-muted">{t("Paid on")}</dt>
              <dd className="text-right">{formatDate(invoice.paidAt, locale)}</dd>
            </>
          )}
        </dl>
      </div>

      <div className="mt-8 grid gap-6 text-sm sm:grid-cols-2">
        <div>
          <p className="mb-1 text-xs font-semibold tracking-wide text-muted uppercase">{t("From")}</p>
          <p className="font-medium">{general.companyName || general.siteName}</p>
          <p className="whitespace-pre-line text-muted">{general.companyAddress}</p>
          {general.companyVatId && <p className="text-muted">{billing.taxName}: {general.companyVatId}</p>}
        </div>
        <div>
          <p className="mb-1 text-xs font-semibold tracking-wide text-muted uppercase">{t("Billed to")}</p>
          <p className="font-medium">{c.company || displayName(c)}</p>
          {c.company && <p className="text-muted">{displayName(c)}</p>}
          <p className="text-muted">{[c.address, [c.zip, c.city].filter(Boolean).join(" "), c.state, c.country].filter(Boolean).join(", ")}</p>
          {c.vatId && <p className="text-muted">{billing.taxName}: {c.vatId}</p>}
          {c.taxCode && <p className="text-muted">{t("Tax code")}: {c.taxCode}</p>}
        </div>
      </div>

      <table className="mt-8 w-full text-sm">
        <thead>
          <tr className="border-b border-border text-left text-xs tracking-wide text-muted uppercase">
            <th className="py-2 font-medium">{t("Description")}</th>
            <th className="py-2 text-right font-medium">{t("Amount")}</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {invoice.items.map((item) => (
            <tr key={item.id}>
              <td className="py-3 pr-4">{item.description}</td>
              <td className="py-3 text-right whitespace-nowrap">{money(item.amount)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot className="border-t border-border">
          <tr>
            <td className="pt-3 text-right text-muted">{t("Subtotal")}</td>
            <td className="pt-3 text-right">{money(invoice.subtotal)}</td>
          </tr>
          {invoice.taxRate > 0 && (
            <tr>
              <td className="pt-1 text-right text-muted">
                {billing.taxName} {invoice.taxRate / 100}%
              </td>
              <td className="pt-1 text-right">{money(invoice.tax)}</td>
            </tr>
          )}
          <tr className="text-base font-bold">
            <td className="pt-2 text-right">{t("Total")}</td>
            <td className="pt-2 text-right">{money(invoice.total)}</td>
          </tr>
        </tfoot>
      </table>

      {invoice.transactions.length > 0 && (
        <div className="mt-8 text-sm">
          <p className="mb-2 text-xs font-semibold tracking-wide text-muted uppercase">{t("Payments")}</p>
          <ul className="space-y-1">
            {invoice.transactions.map((tx) => (
              <li key={tx.id} className="flex justify-between gap-4 text-muted">
                <span>
                  {formatDate(tx.createdAt, locale)} · {tx.gateway}
                  {tx.externalId && <span className="font-mono text-xs"> · {tx.externalId}</span>}
                </span>
                <span>{money(tx.amount)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {invoice.notes && <p className="mt-8 text-sm whitespace-pre-line text-muted">{invoice.notes}</p>}
    </Card>
  );
}
