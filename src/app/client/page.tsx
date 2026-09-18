import Link from "next/link";
import { and, count, desc, eq, inArray, sum } from "drizzle-orm";
import { ButtonLink, Card, CardHeader, EmptyState, Stat, StatusBadge, Table, Td, STATUS_LABEL } from "@/components/ui";
import { getDb, schema } from "@/db";
import { getLocale, getT } from "@/i18n";
import { requireUser } from "@/lib/auth";
import { formatDate, formatMoney } from "@/lib/format";
import { getSettings } from "@/lib/settings";

export default async function ClientDashboard() {
  const user = await requireUser();
  const db = await getDb();
  const [t, locale, billing] = await Promise.all([getT(), getLocale(), getSettings("billing")]);

  const [[active], [unpaid], [openTickets], services] = await Promise.all([
    db.select({ n: count() }).from(schema.services).where(and(eq(schema.services.clientId, user.id), eq(schema.services.status, "active"))),
    db.select({ n: count(), total: sum(schema.invoices.total) }).from(schema.invoices).where(and(eq(schema.invoices.clientId, user.id), eq(schema.invoices.status, "unpaid"))),
    db.select({ n: count() }).from(schema.tickets).where(and(eq(schema.tickets.clientId, user.id), inArray(schema.tickets.status, ["open", "answered", "customer_reply"]))),
    db.query.services.findMany({ where: eq(schema.services.clientId, user.id), with: { product: true }, orderBy: desc(schema.services.createdAt), limit: 5 }),
  ]);

  return (
    <>
      <h1 className="mb-6 text-2xl font-bold tracking-tight">{t("Welcome back, {name}", { name: user.firstName || user.email })}</h1>
      <div className="mb-8 grid gap-4 sm:grid-cols-3">
        <Stat label={t("Active services")} value={active.n} />
        <Stat label={t("Unpaid invoices")} value={unpaid.n} hint={unpaid.n ? formatMoney(Number(unpaid.total ?? 0), billing.currency, locale) : undefined} />
        <Stat label={t("Open tickets")} value={openTickets.n} />
      </div>
      <Card>
        <CardHeader title={t("Your services")} action={<ButtonLink href="/#pricing" size="sm">{t("Order new")}</ButtonLink>} />
        {services.length ? (
          <Table head={[t("Service"), t("Status"), t("Next due")]}>
            {services.map((s) => (
              <tr key={s.id}>
                <Td>
                  <Link href={`/client/services/${s.id}`} className="font-medium hover:text-primary">{s.product.name}</Link>
                  {s.domain && <span className="block text-xs text-muted">{s.domain}</span>}
                </Td>
                <Td><StatusBadge status={s.status} label={t(STATUS_LABEL[s.status])} /></Td>
                <Td>{formatDate(s.nextDueDate, locale)}</Td>
              </tr>
            ))}
          </Table>
        ) : (
          <EmptyState title={t("No services yet")} description={t("Your hosting plans will show up here.")} action={<ButtonLink href="/#pricing">{t("Browse plans")}</ButtonLink>} />
        )}
      </Card>
    </>
  );
}
