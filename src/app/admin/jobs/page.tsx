import Link from "next/link";
import { desc } from "drizzle-orm";
import { AutoRefresh } from "@/components/auto-refresh";
import { Card, EmptyState, PageHeader, StatusBadge, Table, Td } from "@/components/ui";
import { getDb, schema } from "@/db";
import { getLocale, getT } from "@/i18n";
import { formatDateTime } from "@/lib/format";

export default async function Jobs() {
  const db = await getDb();
  const [t, locale, jobs] = await Promise.all([
    getT(),
    getLocale(),
    db.query.jobs.findMany({ with: { node: { columns: { name: true } }, workload: { columns: { name: true } } }, orderBy: desc(schema.jobs.createdAt), limit: 150 }),
  ]);
  const secs = (j: (typeof jobs)[number]) => (j.startedAt && j.finishedAt ? `${Math.max(1, Math.round((j.finishedAt.getTime() - j.startedAt.getTime()) / 1000))}s` : "—");
  return (
    <>
      <AutoRefresh active={jobs.some((j) => j.status === "queued" || j.status === "running")} />
      <PageHeader title={t("Jobs")} description={t("Signed work sent to node agents, with its log and outcome.")} />
      <Card>
        {jobs.length ? (
          <Table head={[t("Job"), t("Workload"), t("Node"), t("Created"), t("Duration"), t("Status")]}>
            {jobs.map((j) => (
              <tr key={j.id}>
                <Td><Link href={`/admin/jobs/${j.id}`} className="font-mono text-xs font-medium hover:text-link">{j.type}</Link></Td>
                <Td>{j.workload?.name ?? "—"}</Td>
                <Td>{j.node.name}</Td>
                <Td className="text-muted">{formatDateTime(j.createdAt, locale)}</Td>
                <Td>{secs(j)}</Td>
                <Td><StatusBadge status={j.status} label={t(j.status)} /></Td>
              </tr>
            ))}
          </Table>
        ) : (
          <EmptyState title={t("No jobs yet")} />
        )}
      </Card>
    </>
  );
}
