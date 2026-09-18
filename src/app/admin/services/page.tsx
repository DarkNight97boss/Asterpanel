import Link from "next/link";
import { desc, eq } from "drizzle-orm";
import { Card, EmptyState, PageHeader, StatusBadge, STATUS_LABEL, Table, Td, cn } from "@/components/ui";
import { getDb, schema } from "@/db";
import type { ServiceStatus } from "@/db/schema";
import { getLocale, getT } from "@/i18n";
import { displayName } from "@/lib/auth";
import { formatDate, formatMoney } from "@/lib/format";
import { getSettings } from "@/lib/settings";

const FILTERS: ServiceStatus[] = ["pending", "active", "suspended", "terminated", "cancelled"];

export default async function Services({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const { status } = await searchParams;
  const filter = FILTERS.find((f) => f === status);
  const db = await getDb();
  const [t, locale, billing, services] = await Promise.all([
    getT(),
    getLocale(),
    getSettings("billing"),
    db.query.services.findMany({
      where: filter ? eq(schema.services.status, filter) : undefined,
      with: { product: true, client: { columns: { passwordHash: false } } },
      orderBy: desc(schema.services.createdAt),
      limit: 300,
    }),
  ]);
  const tab = (active: boolean) => cn("rounded-full px-3 py-1 text-sm", active ? "bg-primary text-primary-fg" : "text-muted hover:bg-surface");

  return (
    <>
      <PageHeader title={t("Services")} />
      <div className="mb-4 flex flex-wrap gap-1">
        <Link href="/admin/services" className={tab(!filter)}>{t("All")}</Link>
        {FILTERS.map((f) => (
          <Link key={f} href={`/admin/services?status=${f}`} className={tab(filter === f)}>{t(STATUS_LABEL[f])}</Link>
        ))}
      </div>
      <Card>
        {services.length ? (
          <Table head={[t("Service"), t("Client"), t("Price"), t("Next due"), t("Status")]}>
            {services.map((s) => (
              <tr key={s.id}>
                <Td>
                  <Link href={`/admin/services/${s.id}`} className="font-medium hover:text-primary">{s.product.name}</Link>
                  {s.domain && <span className="block text-xs text-muted">{s.domain}</span>}
                </Td>
                <Td><Link href={`/admin/clients/${s.clientId}`} className="hover:text-primary">{displayName(s.client)}</Link></Td>
                <Td>{formatMoney(s.amount, billing.currency, locale)}</Td>
                <Td>{formatDate(s.nextDueDate, locale)}</Td>
                <Td><StatusBadge status={s.status} label={t(STATUS_LABEL[s.status])} /></Td>
              </tr>
            ))}
          </Table>
        ) : (
          <EmptyState title={t("No services found")} />
        )}
      </Card>
    </>
  );
}
