import Link from "next/link";
import { and, eq, ilike, ne, or, sql } from "drizzle-orm";
import { Card, EmptyState, PageHeader, StatusBadge } from "@/components/ui";
import { getDb, schema } from "@/db";
import { getT } from "@/i18n";
import { requireAccount } from "@/lib/account";
import { getSettings } from "@/lib/settings";
import { WORKLOAD_LABEL } from "@/platform/ui";

export default async function Search({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const { account, can } = await requireAccount("support");
  const q = ((await searchParams).q ?? "").trim().slice(0, 80);
  const like = `%${q.replace(/[%_\\]/g, "\\$&")}%`;
  const db = await getDb();
  const [t, billing] = await Promise.all([getT(), getSettings("billing")]);
  const number = Number(q.replace(/\D/g, "")) || -1;

  const [workloads, zones, invoices, tickets] = q.length < 2 ? [[], [], [], []] : await Promise.all([
    can("hosting")
      ? db.selectDistinct({ w: schema.workloads }).from(schema.workloads).leftJoin(schema.domains, eq(schema.domains.workloadId, schema.workloads.id))
          .where(and(eq(schema.workloads.clientId, account.id), ne(schema.workloads.status, "deleted"), or(ilike(schema.workloads.name, like), ilike(schema.workloads.slug, like), ilike(schema.domains.hostname, like)))).limit(15)
      : [],
    can("hosting") ? db.select().from(schema.dnsZones).where(and(eq(schema.dnsZones.clientId, account.id), ilike(schema.dnsZones.name, like))).limit(10) : [],
    can("billing") ? db.select().from(schema.invoices).where(and(eq(schema.invoices.clientId, account.id), eq(schema.invoices.number, number))).limit(5) : [],
    db.select().from(schema.tickets).where(and(eq(schema.tickets.clientId, account.id), or(ilike(schema.tickets.subject, like), sql`${schema.tickets.number} = ${number}`))).limit(10),
  ]);
  const total = workloads.length + zones.length + invoices.length + tickets.length;
  const Row = ({ href, title, meta, right }: { href: string; title: string; meta: string; right?: React.ReactNode }) => (
    <li><Link href={href} className="flex items-center gap-4 px-6 py-3.5 hover:bg-subtle"><span className="min-w-0 flex-1"><span className="block truncate font-medium text-fg">{title}</span><span className="block truncate text-xs text-muted">{meta}</span></span>{right}</Link></li>
  );

  return (
    <>
      <PageHeader title={t("Search")} description={q ? t("{n} results for “{q}”", { n: total, q }) : undefined} />
      <Card>
        {total ? (
          <ul className="divide-y divide-border">
            {workloads.map(({ w }) => Row({ href: `/client/workloads/${w.id}`, title: w.name, meta: `${t(WORKLOAD_LABEL[w.type].one)} · ${w.slug}`, right: <StatusBadge status={w.status} label={t(w.status)} /> }))}
            {zones.map((z) => Row({ href: `/client/dns/${z.id}`, title: z.name, meta: t("DNS management") }))}
            {invoices.map((inv) => Row({ href: `/client/invoices/${inv.id}`, title: `${billing.invoicePrefix}${inv.number}`, meta: t("Invoice"), right: <StatusBadge status={inv.status} /> }))}
            {tickets.map((tk) => Row({ href: `/client/tickets/${tk.id}`, title: `#${tk.number} · ${tk.subject}`, meta: t("Support") }))}
          </ul>
        ) : (
          <EmptyState title={q.length < 2 ? t("Type at least two characters") : t("No results")} description={t("Search services, domains, DNS zones, invoice numbers and tickets.")} />
        )}
      </Card>
    </>
  );
}
