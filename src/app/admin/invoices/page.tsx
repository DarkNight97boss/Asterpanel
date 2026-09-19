import Link from "next/link";
import { desc, eq } from "drizzle-orm";
import { Card, EmptyState, PageHeader, StatusBadge, STATUS_LABEL, Table, Td, cn } from "@/components/ui";
import { getDb, schema } from "@/db";
import type { InvoiceStatus } from "@/db/schema";
import { getLocale, getT } from "@/i18n";
import { displayName, requireArea } from "@/lib/auth";
import { formatDate, formatMoney, invoiceLabel } from "@/lib/format";
import { getSettings } from "@/lib/settings";

const FILTERS: InvoiceStatus[] = ["unpaid", "paid", "cancelled"];

export default async function Invoices({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  await requireArea("billing");
  const { status } = await searchParams;
  const filter = FILTERS.find((f) => f === status);
  const db = await getDb();
  const [t, locale, billing, invoices] = await Promise.all([
    getT(),
    getLocale(),
    getSettings("billing"),
    db.query.invoices.findMany({
      where: filter ? eq(schema.invoices.status, filter) : undefined,
      with: { client: { columns: { passwordHash: false } } },
      orderBy: desc(schema.invoices.createdAt),
      limit: 300,
    }),
  ]);
  const tab = (active: boolean) => cn("rounded-full px-3 py-1 text-sm", active ? "bg-primary text-primary-fg" : "text-muted hover:bg-surface");

  return (
    <>
      <PageHeader title={t("Invoices")} />
      <div className="mb-4 flex flex-wrap gap-1">
        <Link href="/admin/invoices" className={tab(!filter)}>{t("All")}</Link>
        {FILTERS.map((f) => (
          <Link key={f} href={`/admin/invoices?status=${f}`} className={tab(filter === f)}>{t(STATUS_LABEL[f])}</Link>
        ))}
      </div>
      <Card>
        {invoices.length ? (
          <Table head={[t("Invoice"), t("Client"), t("Issued"), t("Due"), t("Total"), t("Status")]}>
            {invoices.map((inv) => (
              <tr key={inv.id}>
                <Td><Link href={`/admin/invoices/${inv.id}`} className="font-medium hover:text-link">{invoiceLabel(billing.invoicePrefix, inv)}</Link></Td>
                <Td><Link href={`/admin/clients/${inv.clientId}`} className="hover:text-link">{displayName(inv.client)}</Link></Td>
                <Td>{formatDate(inv.createdAt, locale)}</Td>
                <Td>{formatDate(inv.dueDate, locale)}</Td>
                <Td>{formatMoney(inv.total, inv.currency, locale)}</Td>
                <Td><StatusBadge status={inv.status} label={t(STATUS_LABEL[inv.status])} /></Td>
              </tr>
            ))}
          </Table>
        ) : (
          <EmptyState title={t("No invoices found")} />
        )}
      </Card>
    </>
  );
}
