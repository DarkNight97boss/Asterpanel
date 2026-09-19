import Link from "next/link";
import { and, desc, eq, ne } from "drizzle-orm";
import { AutoRefresh } from "@/components/auto-refresh";
import { Button, ButtonLink, Card, EmptyState, Input, PageHeader, Select, StatusBadge, Table, Td } from "@/components/ui";
import { getDb, schema } from "@/db";
import type { WorkloadType } from "@/db/schema";
import { getLocale, getT } from "@/i18n";
import { mayAccess, requireAccount } from "@/lib/account";
import { formatDate } from "@/lib/format";
import { WORKLOAD_LABEL } from "@/platform/ui";

export async function WorkloadList({ type, filters = {} }: { type: WorkloadType; filters?: { q?: string; status?: string } }) {
  const { account: user, can } = await requireAccount("hosting");
  const db = await getDb();
  const label = WORKLOAD_LABEL[type];
  const [t, locale, rows] = await Promise.all([
    getT(),
    getLocale(),
    db.query.workloads.findMany({
      where: and(eq(schema.workloads.clientId, user.id), eq(schema.workloads.type, type), ne(schema.workloads.status, "deleted")),
      with: { domains: true, node: { columns: { region: true } } },
      orderBy: desc(schema.workloads.createdAt),
    }),
  ]);
  const q = (filters.q ?? "").trim().toLowerCase().slice(0, 80);
  const all = rows.filter((w) => w.environment === "live" && mayAccess(user, w));
  const live = all.filter(
    (w) => (!filters.status || w.status === filters.status) && (!q || w.name.toLowerCase().includes(q) || w.domains.some((d) => d.hostname.includes(q))),
  );
  const newHref = `/client/new/${label.path.split("/").pop()}`;

  return (
    <>
      <AutoRefresh active={rows.some((w) => w.status === "creating" || w.status === "deleting")} />
      <PageHeader title={t(label.many)} description={t(label.blurb)} action={can("manage") && !user.only && <ButtonLink href={newHref}>+ {t(label.one)}</ButtonLink>} />
      <Card>
        {all.length > 0 && (
          <form className="flex flex-wrap items-center gap-3 px-6 pt-6">
            <Input name="q" type="search" defaultValue={filters.q} placeholder={t("Search…")} className="w-60" />
            <Select name="status" defaultValue={filters.status ?? ""} className="w-44">
              <option value="">{t("All statuses")}</option>
              {["running", "stopped", "suspended", "error", "creating"].map((st) => <option key={st} value={st}>{t(st)}</option>)}
            </Select>
            <Button variant="secondary">{t("Filter")}</Button>
            <span className="ml-auto text-xs font-medium text-muted">{t("{n} of {total}", { n: live.length, total: all.length })}</span>
          </form>
        )}
        {live.length ? (
          <Table head={[t("Name"), type === "database" ? t("Engine") : t("Primary domain"), t("Region"), t("Created"), t("Status")]}>
            {live.map((w) => {
              const host = w.domains.find((d) => d.isPrimary)?.hostname;
              const hasStaging = rows.some((s) => s.parentId === w.id);
              return (
                <tr key={w.id}>
                  <Td>
                    <Link href={`/client/workloads/${w.id}`} className="font-medium hover:text-link">{w.name}</Link>
                    {hasStaging && <span className="ml-2 rounded-full bg-subtle px-2 py-0.5 text-[10px] font-semibold text-muted uppercase">+ staging</span>}
                  </Td>
                  <Td className="text-muted">{type === "database" ? `${w.config.engine ?? ""} ${w.config.version ?? ""}` : (host ?? "—")}</Td>
                  <Td>{w.node.region || "—"}</Td>
                  <Td>{formatDate(w.createdAt, locale)}</Td>
                  <Td><StatusBadge status={w.status} label={t(w.status)} /></Td>
                </tr>
              );
            })}
          </Table>
        ) : (
          <EmptyState title={all.length ? t("No results") : t("Nothing here yet")} description={all.length ? undefined : t(label.blurb)} action={can("manage") && !user.only && <ButtonLink href={newHref}>+ {t(label.one)}</ButtonLink>} />
        )}
      </Card>
    </>
  );
}
