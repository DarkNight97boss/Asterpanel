import Link from "next/link";
import { count, desc, eq, gte, inArray, sum } from "drizzle-orm";
import { Card, CardHeader, EmptyState, Stat, StatusBadge, STATUS_LABEL, Table, Td } from "@/components/ui";
import { getDb, schema } from "@/db";
import { getLocale, getT } from "@/i18n";
import { displayName } from "@/lib/auth";
import { formatDateTime, formatMoney } from "@/lib/format";
import { getSettings } from "@/lib/settings";

export default async function AdminDashboard() {
  const db = await getDb();
  const [t, locale, billing] = await Promise.all([getT(), getLocale(), getSettings("billing")]);
  const monthStart = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1));

  const [[clients], [active], [pending], [unpaid], [revenue], [tickets], orders] = await Promise.all([
    db.select({ n: count() }).from(schema.users).where(eq(schema.users.role, "client")),
    db.select({ n: count() }).from(schema.services).where(eq(schema.services.status, "active")),
    db.select({ n: count() }).from(schema.services).where(eq(schema.services.status, "pending")),
    db.select({ n: count(), total: sum(schema.invoices.total) }).from(schema.invoices).where(eq(schema.invoices.status, "unpaid")),
    db.select({ total: sum(schema.transactions.amount) }).from(schema.transactions).where(gte(schema.transactions.createdAt, monthStart)),
    db.select({ n: count() }).from(schema.tickets).where(inArray(schema.tickets.status, ["open", "customer_reply"])),
    db.query.orders.findMany({ with: { client: { columns: { passwordHash: false } } }, orderBy: desc(schema.orders.createdAt), limit: 8 }),
  ]);
  const money = (v: unknown) => formatMoney(Number(v ?? 0), billing.currency, locale);

  return (
    <>
      <h1 className="mb-6 text-2xl font-bold tracking-tight">{t("Dashboard")}</h1>
      <div className="mb-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label={t("Revenue this month")} value={money(revenue.total)} />
        <Stat label={t("Active services")} value={active.n} hint={pending.n ? t("{n} pending activation", { n: pending.n }) : undefined} />
        <Stat label={t("Unpaid invoices")} value={unpaid.n} hint={money(unpaid.total)} />
        <Stat label={t("Tickets awaiting reply")} value={tickets.n} hint={t("{n} clients", { n: clients.n })} />
      </div>
      <Card>
        <CardHeader title={t("Recent orders")} />
        {orders.length ? (
          <Table head={["#", t("Client"), t("Date"), t("Total"), t("Status")]}>
            {orders.map((o) => (
              <tr key={o.id}>
                <Td className="text-muted">{o.number}</Td>
                <Td>
                  <Link href={`/admin/clients/${o.clientId}`} className="font-medium hover:text-primary">{displayName(o.client)}</Link>
                </Td>
                <Td>{formatDateTime(o.createdAt, locale)}</Td>
                <Td>{money(o.total)}</Td>
                <Td><StatusBadge status={o.status} label={t(STATUS_LABEL[o.status])} /></Td>
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
