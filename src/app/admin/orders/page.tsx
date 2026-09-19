import Link from "next/link";
import { desc } from "drizzle-orm";
import { Card, EmptyState, PageHeader, StatusBadge, STATUS_LABEL, Table, Td } from "@/components/ui";
import { getDb, schema } from "@/db";
import { getLocale, getT } from "@/i18n";
import { displayName } from "@/lib/auth";
import { formatDateTime, formatMoney } from "@/lib/format";
import { getSettings } from "@/lib/settings";

export default async function Orders() {
  const db = await getDb();
  const [t, locale, billing, orders] = await Promise.all([
    getT(),
    getLocale(),
    getSettings("billing"),
    db.query.orders.findMany({
      with: { client: { columns: { passwordHash: false } }, services: { with: { product: true } } },
      orderBy: desc(schema.orders.createdAt),
      limit: 200,
    }),
  ]);

  return (
    <>
      <PageHeader title={t("Orders")} />
      <Card>
        {orders.length ? (
          <Table head={["#", t("Client"), t("Items"), t("Date"), t("Total"), t("Status"), ""]}>
            {orders.map((o) => (
              <tr key={o.id}>
                <Td className="text-muted">{o.number}</Td>
                <Td>
                  <Link href={`/admin/clients/${o.clientId}`} className="font-medium hover:text-link">{displayName(o.client)}</Link>
                </Td>
                <Td>
                  {o.services.map((s) => (
                    <Link key={s.id} href={`/admin/services/${s.id}`} className="block hover:text-link">
                      {s.product.name} {s.domain && <span className="text-xs text-muted">{s.domain}</span>}
                    </Link>
                  ))}
                </Td>
                <Td>{formatDateTime(o.createdAt, locale)}</Td>
                <Td>{formatMoney(o.total, billing.currency, locale)}</Td>
                <Td><StatusBadge status={o.status} label={t(STATUS_LABEL[o.status])} /></Td>
                <Td>{o.invoiceId && <Link href={`/admin/invoices/${o.invoiceId}`} className="text-link">{t("Invoice")}</Link>}</Td>
              </tr>
            ))}
          </Table>
        ) : (
          <EmptyState title={t("No orders yet")} />
        )}
      </Card>
    </>
  );
}
