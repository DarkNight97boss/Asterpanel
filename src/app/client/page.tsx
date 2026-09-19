import Link from "next/link";
import { and, count, desc, eq, inArray, ne, sum } from "drizzle-orm";
import { AutoRefresh } from "@/components/auto-refresh";
import { Alert, ButtonLink, Card, CardHeader, EmptyState, StatusBadge, Table, Td } from "@/components/ui";
import { getDb, schema } from "@/db";
import { WORKLOAD_TYPES } from "@/db/schema";
import { getLocale, getT } from "@/i18n";
import { mayAccess, requireAccount } from "@/lib/account";
import { formatDate, formatMoney } from "@/lib/format";
import { getSettings } from "@/lib/settings";
import { WORKLOAD_LABEL } from "@/platform/ui";

const JOB_TEXT: Record<string, string> = {
  "workload.create": "Create service",
  "workload.update": "Change settings",
  "workload.start": "Start",
  "workload.stop": "Stop",
  "workload.restart": "Restart",
  "workload.delete": "Delete service",
  "workload.clone": "Copy environment",
  "workload.deploy": "Deploy",
  "workload.tool": "Run tool",
  "backup.create": "Create backup",
  "backup.restore": "Restore backup",
  "backup.delete": "Delete backup",
};

export default async function ClientDashboard() {
  const { user: me, account: user } = await requireAccount("support");
  const db = await getDb();
  const mine = and(eq(schema.workloads.companyId, user.id), ne(schema.workloads.status, "deleted"), eq(schema.workloads.environment, "live"));
  const [t, locale, billing, counts, recent, [unpaid], [tickets]] = await Promise.all([
    getT(),
    getLocale(),
    getSettings("billing"),
    db.select({ type: schema.workloads.type, n: count() }).from(schema.workloads).where(mine).groupBy(schema.workloads.type),
    db.query.workloads.findMany({ where: mine, with: { domains: true }, orderBy: desc(schema.workloads.updatedAt), limit: 50 }),
    db.select({ n: count(), total: sum(schema.invoices.total) }).from(schema.invoices).where(and(eq(schema.invoices.companyId, user.id), eq(schema.invoices.status, "unpaid"))),
    db.select({ n: count() }).from(schema.tickets).where(and(eq(schema.tickets.companyId, user.id), inArray(schema.tickets.status, ["open", "answered", "customer_reply"]))),
  ]);
  const myIds = (await db.select({ id: schema.workloads.id, name: schema.workloads.name, parentId: schema.workloads.parentId }).from(schema.workloads).where(eq(schema.workloads.companyId, user.id))).filter((w) => mayAccess(user, w));
  const names = new Map(myIds.map((w) => [w.id, w.name]));
  const [activity, invoices, answered] = await Promise.all([
    myIds.length
      ? db.select().from(schema.jobs).where(and(inArray(schema.jobs.workloadId, myIds.map((w) => w.id)), ne(schema.jobs.type, "workload.logs"))).orderBy(desc(schema.jobs.createdAt)).limit(6)
      : [],
    db.select().from(schema.invoices).where(eq(schema.invoices.companyId, user.id)).orderBy(desc(schema.invoices.createdAt)).limit(4),
    db.select().from(schema.tickets).where(and(eq(schema.tickets.companyId, user.id), eq(schema.tickets.status, "answered"))).orderBy(desc(schema.tickets.lastReplyAt)).limit(3),
  ]);
  const notifications = [
    ...answered.map((tk) => ({ at: tk.lastReplyAt, href: `/client/tickets/${tk.id}`, text: t("Support replied: {subject}", { subject: tk.subject }) })),
    ...invoices.map((inv) => ({ at: inv.paidAt ?? inv.createdAt, href: `/client/invoices/${inv.id}`, text: inv.status === "paid" ? t("Invoice paid") : inv.status === "unpaid" ? t("New invoice to pay") : t("Invoice updated") })),
  ].sort((a, b) => b.at.getTime() - a.at.getTime()).slice(0, 6);

  const visible = recent.filter((w) => mayAccess(user, w));
  // Restricted members get exact counts from what they can see; everyone else from SQL.
  const n = (type: string) => (user.only ? visible.filter((w) => w.type === type).length : (counts.find((c) => c.type === type)?.n ?? 0));

  return (
    <>
      <AutoRefresh active={recent.some((w) => w.status === "creating")} />
      <h1 className="mb-6 text-[2rem] leading-tight">{t("Welcome back, {name}", { name: me.firstName || me.email })}</h1>
      {unpaid.n > 0 && (
        <div className="mb-6">
          <Alert tone="warning">
            {t("You have {n} unpaid invoices ({total}).", { n: unpaid.n, total: formatMoney(Number(unpaid.total ?? 0), billing.currency, locale) })}{" "}
            <Link href="/client/invoices" className="font-semibold underline">{t("Pay now")}</Link>
          </Alert>
        </div>
      )}
      <div className="mb-8 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {WORKLOAD_TYPES.map((type) => {
          const l = WORKLOAD_LABEL[type];
          return (
            <Link key={type} href={l.path} className="group rounded-theme border border-border bg-surface p-5 transition hover:border-accent">
              <div className="flex items-center justify-between">
                <span className="grid size-10 place-items-center rounded-theme bg-accent/10 text-lg text-link">{l.icon}</span>
                <span className="text-3xl font-bold tracking-tight">{n(type)}</span>
              </div>
              <p className="mt-4 font-semibold group-hover:text-link">{t(l.many)}</p>
              <p className="mt-1 text-xs leading-relaxed text-muted">{t(l.blurb)}</p>
            </Link>
          );
        })}
      </div>
      <div className="mb-8 grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader title={t("Recent activity")} />
          {activity.length ? (
            <ul className="px-3 pt-3 pb-4 text-sm">
              {activity.map((j) => (
                <li key={j.id}>
                  <Link href={`/client/workloads/${j.workloadId}/activity`} className="flex items-center gap-3 rounded-md px-3 py-2.5 hover:bg-subtle">
                    <span aria-hidden className="grid size-8 shrink-0 place-items-center rounded-full bg-subtle text-xs">{(names.get(j.workloadId ?? "") ?? "?").slice(0, 1).toUpperCase()}</span>
                    <span className="min-w-0 flex-1 truncate text-body">{t(JOB_TEXT[j.type] ?? j.type)} · {names.get(j.workloadId ?? "")}</span>
                    <span aria-hidden className={j.status === "failed" ? "text-danger" : j.status === "succeeded" ? "text-success" : "text-warning"}>{j.status === "failed" ? "⊗" : j.status === "succeeded" ? "✓" : "…"}</span>
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState title={t("Nothing here yet")} />
          )}
        </Card>
        <Card>
          <CardHeader title={t("Notifications")} />
          {notifications.length ? (
            <ul className="px-3 pt-3 pb-4 text-sm">
              {notifications.map((n2, i) => (
                <li key={i}>
                  <Link href={n2.href} className="flex items-center justify-between gap-4 rounded-md px-3 py-2.5 hover:bg-subtle">
                    <span className="truncate text-body">{n2.text}</span>
                    <span className="shrink-0 text-xs text-muted">{formatDate(n2.at, locale)}</span>
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState title={t("Nothing here yet")} />
          )}
        </Card>
      </div>

      <Card>
        <CardHeader title={t("Recently updated")} action={tickets.n > 0 && <ButtonLink href="/client/tickets" size="sm" variant="secondary">{t("{n} open tickets", { n: tickets.n })}</ButtonLink>} />
        {visible.length ? (
          <Table head={[t("Name"), t("Type"), t("Primary domain"), t("Status")]}>
            {visible.map((w) => (
              <tr key={w.id}>
                <Td><Link href={`/client/workloads/${w.id}`} className="font-medium hover:text-link">{w.name}</Link></Td>
                <Td>{t(WORKLOAD_LABEL[w.type].one)}</Td>
                <Td className="text-muted">{w.domains.find((d) => d.isPrimary)?.hostname ?? "—"}</Td>
                <Td><StatusBadge status={w.status} label={t(w.status)} /></Td>
              </tr>
            ))}
          </Table>
        ) : (
          <EmptyState title={t("Create your first service")} description={t("Pick what you want to host: it will be online in a minute.")} action={<ButtonLink href="/client/new/sites">+ {t("WordPress site")}</ButtonLink>} />
        )}
      </Card>
    </>
  );
}
