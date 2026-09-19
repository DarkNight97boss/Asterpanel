import Link from "next/link";
import { and, count, desc, eq, gte, inArray, isNotNull, ne, sum } from "drizzle-orm";
import { Badge, Card, CardHeader, EmptyState, Stat, StatusBadge, STATUS_LABEL, Table, Td } from "@/components/ui";
import { getDb, schema } from "@/db";
import { getLocale, getT } from "@/i18n";
import { displayName } from "@/lib/auth";
import { formatDateTime, formatMoney } from "@/lib/format";
import { getSettings } from "@/lib/settings";
import { nodeIsOnline } from "@/platform/engine";

/** Server components render once per request: reading the clock here is fine. */
const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000);

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
  // ── Platform operations ──
  const dayAgo = hoursAgo(24);
  const [nodes, workloadCounts, failedJobs, stuckServices] = await Promise.all([
    db.select().from(schema.nodes).where(ne(schema.nodes.status, "disabled")),
    db.select({ status: schema.workloads.status, n: count() }).from(schema.workloads).where(ne(schema.workloads.status, "deleted")).groupBy(schema.workloads.status),
    db.query.jobs.findMany({
      where: and(eq(schema.jobs.status, "failed"), gte(schema.jobs.createdAt, dayAgo)),
      with: { workload: { columns: { name: true } }, node: { columns: { name: true } } },
      orderBy: desc(schema.jobs.createdAt),
      limit: 6,
    }),
    db.query.services.findMany({ where: and(eq(schema.services.status, "pending"), isNotNull(schema.services.nextDueDate)), with: { product: true }, limit: 6 }),
  ]);
  const online = nodes.filter(nodeIsOnline);
  const wl = (status: string) => workloadCounts.find((w) => w.status === status)?.n ?? 0;
  const offline = nodes.filter((n) => !nodeIsOnline(n) && n.lastSeenAt);
  const attention = offline.length + failedJobs.length + stuckServices.length + wl("error");

  const money = (v: unknown) => formatMoney(Number(v ?? 0), billing.currency, locale);

  return (
    <>
      <h1 className="mb-6 text-2xl tracking-tight">{t("Dashboard")}</h1>
      <div className="mb-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label={t("Revenue this month")} value={money(revenue.total)} />
        <Stat label={t("Active services")} value={active.n} hint={pending.n ? t("{n} pending activation", { n: pending.n }) : undefined} />
        <Stat label={t("Unpaid invoices")} value={unpaid.n} hint={money(unpaid.total)} />
        <Stat label={t("Tickets awaiting reply")} value={tickets.n} hint={t("{n} clients", { n: clients.n })} />
      </div>
      <div className="mb-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label={t("Nodes online")} value={`${online.length} / ${nodes.length}`} hint={<Link href="/admin/nodes" className="text-link">{t("Nodes")} →</Link>} />
        <Stat label={t("Running workloads")} value={wl("running")} hint={wl("creating") ? t("{n} being created", { n: wl("creating") }) : undefined} />
        <Stat label={t("Workloads in error")} value={wl("error")} hint={wl("suspended") ? t("{n} suspended", { n: wl("suspended") }) : undefined} />
        <Stat label={t("Failed jobs (24h)")} value={failedJobs.length} hint={<Link href="/admin/jobs" className="text-link">{t("Jobs")} →</Link>} />
      </div>

      {attention > 0 && (
        <Card className="mb-8 border-warning/40">
          <CardHeader title={t("Needs attention")} />
          <ul className="divide-y divide-border text-sm">
            {offline.map((n) => (
              <li key={n.id} className="flex items-center gap-3 px-5 py-3">
                <Badge tone="danger">{t("Offline")}</Badge>
                <Link href={`/admin/nodes/${n.id}`} className="font-medium hover:text-link">{n.name}</Link>
                <span className="text-muted">{t("Last seen")} {formatDateTime(n.lastSeenAt, locale)}</span>
              </li>
            ))}
            {stuckServices.map((sv) => (
              <li key={sv.id} className="flex items-center gap-3 px-5 py-3">
                <Badge tone="warning">{t("Paid, not provisioned")}</Badge>
                <Link href={`/admin/services/${sv.id}`} className="font-medium hover:text-link">{sv.product.name}</Link>
                <span className="text-muted">{t("Open it and press Activate to retry.")}</span>
              </li>
            ))}
            {failedJobs.map((j) => (
              <li key={j.id} className="flex items-center gap-3 px-5 py-3">
                <Badge tone="danger">{t("failed")}</Badge>
                <Link href={`/admin/jobs/${j.id}`} className="font-mono text-xs font-medium hover:text-link">{j.type}</Link>
                <span className="min-w-0 flex-1 truncate text-muted">{j.workload?.name} · {j.node.name} · {j.error}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card>
        <CardHeader title={t("Recent orders")} />
        {orders.length ? (
          <Table head={["#", t("Client"), t("Date"), t("Total"), t("Status")]}>
            {orders.map((o) => (
              <tr key={o.id}>
                <Td className="text-muted">{o.number}</Td>
                <Td>
                  <Link href={`/admin/clients/${o.clientId}`} className="font-medium hover:text-link">{displayName(o.client)}</Link>
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
