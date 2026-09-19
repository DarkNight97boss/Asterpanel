import Link from "next/link";
import { desc, eq } from "drizzle-orm";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { Button, Card, CardHeader, EmptyState, PageHeader, StatusBadge } from "@/components/ui";
import { getDb, schema } from "@/db";
import { getLocale, getT } from "@/i18n";
import { requireAccount } from "@/lib/account";
import { formatDate, formatMoney } from "@/lib/format";
import { getSettings } from "@/lib/settings";
import { accept, decline } from "./actions";

export const metadata = { title: "Quotes" };

const TONE: Record<string, string> = { sent: "creating", accepted: "active", declined: "stopped", withdrawn: "stopped" };

export default async function Quotes() {
  const { account } = await requireAccount("billing");
  const [t, locale, billing, quotes] = await Promise.all([getT(), getLocale(), getSettings("billing"), (await getDb()).select().from(schema.quotes).where(eq(schema.quotes.companyId, account.id)).orderBy(desc(schema.quotes.createdAt))]);
  const money = (c: number) => formatMoney(c, billing.currency, locale);
  const now = new Date();
  return (
    <>
      <PageHeader title={t("Quotes")} description={t("Offers we prepared for {account}. Accepting one creates its invoice.", { account: account.name })} />
      <div className="space-y-6">
        {quotes.length ? quotes.map((q) => {
          const open = q.status === "sent" && q.validUntil >= now;
          return (
            <Card key={q.id}>
              <CardHeader title={<span className="flex flex-wrap items-center gap-3">#{q.number} · {q.title} <StatusBadge status={TONE[q.status]} label={t(q.status === "sent" && !open ? "expired" : q.status)} /></span>} description={t("Valid until {date}", { date: formatDate(q.validUntil, locale) })} />
              <table className="w-full border-t border-border text-sm">
                <tbody className="divide-y divide-border">
                  {q.items.map((i, n) => <tr key={n}><td className="px-5 py-3">{i.description}</td><td className="px-5 py-3 text-right whitespace-nowrap">{money(i.amount)}</td></tr>)}
                  <tr className="font-medium"><td className="px-5 py-3">{t("Total before tax")}</td><td className="px-5 py-3 text-right">{money(q.items.reduce((s, i) => s + i.amount, 0))}</td></tr>
                </tbody>
              </table>
              {q.notes && <p className="border-t border-border px-5 py-4 text-sm whitespace-pre-line text-body">{q.notes}</p>}
              {open && (
                <div className="flex flex-wrap gap-3 border-t border-border p-5">
                  <ActionForm action={accept} className=""><input type="hidden" name="id" value={q.id} /><SubmitButton>{t("Accept and get the invoice")}</SubmitButton></ActionForm>
                  <form action={decline}><input type="hidden" name="id" value={q.id} /><Button variant="ghost">{t("Decline")}</Button></form>
                </div>
              )}
              {q.invoiceId && <p className="border-t border-border px-5 py-4 text-sm"><Link href={`/client/invoices/${q.invoiceId}`} className="text-link">{t("Open the invoice")} →</Link></p>}
            </Card>
          );
        }) : <Card><EmptyState title={t("No quotes")} /></Card>}
      </div>
    </>
  );
}
