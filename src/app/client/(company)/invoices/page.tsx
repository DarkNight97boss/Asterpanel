import Link from "next/link";
import { desc, eq } from "drizzle-orm";
import { Card, EmptyState, PageHeader, StatusBadge, Table, Td, STATUS_LABEL } from "@/components/ui";
import { getDb, schema } from "@/db";
import { getLocale, getT } from "@/i18n";
import { requireAccount } from "@/lib/account";
import { formatDate, formatMoney, invoiceLabel } from "@/lib/format";
import { getSettings } from "@/lib/settings";

export default async function ClientInvoices() {
  const { account: user } = await requireAccount("billing");
  const db = await getDb();
  const [t, locale, billing, invoices] = await Promise.all([
    getT(),
    getLocale(),
    getSettings("billing"),
    db.select().from(schema.invoices).where(eq(schema.invoices.companyId, user.id)).orderBy(desc(schema.invoices.createdAt)),
  ]);

  return (
    <>
      <PageHeader title={t("Invoices")} />
      <Card>
        {invoices.length ? (
          <Table head={[t("Invoice"), t("Issued"), t("Due"), t("Total"), t("Status")]}>
            {invoices.map((inv) => (
              <tr key={inv.id}>
                <Td>
                  <Link href={`/client/invoices/${inv.id}`} className="font-medium hover:text-link">
                    {invoiceLabel(billing.invoicePrefix, inv)}
                  </Link>
                </Td>
                <Td>{formatDate(inv.createdAt, locale)}</Td>
                <Td>{formatDate(inv.dueDate, locale)}</Td>
                <Td>{formatMoney(inv.total, inv.currency, locale)}</Td>
                <Td><StatusBadge status={inv.status} label={t(STATUS_LABEL[inv.status])} /></Td>
              </tr>
            ))}
          </Table>
        ) : (
          <EmptyState title={t("No invoices yet")} />
        )}
      </Card>
    </>
  );
}
