import Link from "next/link";
import { asc, desc, eq } from "drizzle-orm";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { Button, Card, CardHeader, EmptyState, Field, Input, PageHeader, Select, StatusBadge, Table, Td, Textarea } from "@/components/ui";
import { getDb, schema } from "@/db";
import { getLocale, getT } from "@/i18n";
import { requireArea } from "@/lib/auth";
import { formatDate, formatMoney } from "@/lib/format";
import { getSettings } from "@/lib/settings";
import { newQuote, withdrawQuote } from "./actions";

export const metadata = { title: "Quotes" };

const TONE: Record<string, string> = { sent: "creating", accepted: "active", declined: "stopped", withdrawn: "stopped" };

export default async function Quotes() {
  await requireArea("billing");
  const db = await getDb();
  const [t, locale, billing, quotes, companies] = await Promise.all([
    getT(),
    getLocale(),
    getSettings("billing"),
    db.select({ q: schema.quotes, company: schema.companies.name }).from(schema.quotes).innerJoin(schema.companies, eq(schema.companies.id, schema.quotes.companyId)).orderBy(desc(schema.quotes.createdAt)).limit(200),
    db.select({ id: schema.companies.id, name: schema.companies.name }).from(schema.companies).orderBy(asc(schema.companies.name)).limit(1000),
  ]);
  const money = (c: number) => formatMoney(c, billing.currency, locale);
  const now = new Date();

  return (
    <>
      <PageHeader title={t("Quotes")} description={t("Offers for work outside the catalogue. When the customer accepts, the quote becomes an invoice.")} />
      <div className="space-y-6">
        <Card>
          {quotes.length ? (
            <Table head={["#", t("Title"), t("Customer"), t("Total"), t("Valid until"), t("Status"), ""]}>
              {quotes.map(({ q, company }) => (
                <tr key={q.id}>
                  <Td className="text-muted">{q.number}</Td>
                  <Td className="font-medium">{q.title}</Td>
                  <Td className="text-body">{company}</Td>
                  <Td>{money(q.items.reduce((s, i) => s + i.amount, 0))}</Td>
                  <Td className={q.status === "sent" && q.validUntil < now ? "text-danger" : "text-body"}>{formatDate(q.validUntil, locale)}</Td>
                  <Td><StatusBadge status={TONE[q.status]} label={t(q.status)} /></Td>
                  <Td className="text-right">
                    {q.status === "sent" && <form action={withdrawQuote}><input type="hidden" name="id" value={q.id} /><Button size="sm" variant="ghost">{t("Withdraw")}</Button></form>}
                    {q.invoiceId && <Link href={`/admin/invoices/${q.invoiceId}`} className="text-sm text-link">{t("Invoice")} →</Link>}
                  </Td>
                </tr>
              ))}
            </Table>
          ) : (
            <EmptyState title={t("Nothing here yet")} />
          )}
        </Card>
        <Card>
          <CardHeader title={t("New quote")} />
          <div className="p-5">
            <ActionForm action={newQuote}>
              <div className="grid gap-4 sm:grid-cols-[1fr_1fr_10rem]">
                <Field label={t("Customer")}><Select name="companyId" required defaultValue=""><option value="" disabled>—</option>{companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select></Field>
                <Field label={t("Title")}><Input name="title" required maxLength={200} placeholder={t("Migration of 12 sites")} /></Field>
                <Field label={t("Valid for (days)")}><Input name="validDays" type="number" min={1} max={365} defaultValue={30} /></Field>
              </div>
              <Field label={t("Lines")} hint={t("One per line: Description | amount before tax")}><Textarea name="lines" rows={4} required className="font-mono text-xs" placeholder={"Migration of 12 WordPress sites | 600.00\nPerformance audit | 250.00"} /></Field>
              <Field label={t("Notes for the customer")}><Textarea name="notes" rows={2} maxLength={2000} /></Field>
              <SubmitButton>{t("Send quote")}</SubmitButton>
            </ActionForm>
          </div>
        </Card>
      </div>
    </>
  );
}
