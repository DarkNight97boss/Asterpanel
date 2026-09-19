import { and, desc, eq, or } from "drizzle-orm";
import { Card, EmptyState, PageHeader, StatusBadge, Table, Td } from "@/components/ui";
import { getDb, schema } from "@/db";
import { getLocale, getT } from "@/i18n";
import { displayName, formatDateTime } from "@/lib/format";
import { requireWorkload } from "@/platform/access";

export default async function Activity({ params }: { params: Promise<{ id: string }> }) {
  const { workload: w } = await requireWorkload((await params).id);
  const db = await getDb();
  const [t, locale, jobs, users] = await Promise.all([
    getT(),
    getLocale(),
    db.select().from(schema.jobs).where(and(eq(schema.jobs.workloadId, w.id), or(eq(schema.jobs.status, "succeeded"), eq(schema.jobs.status, "failed"), eq(schema.jobs.status, "running"), eq(schema.jobs.status, "queued")))).orderBy(desc(schema.jobs.createdAt)).limit(100),
    db.select({ id: schema.users.id, firstName: schema.users.firstName, lastName: schema.users.lastName, email: schema.users.email }).from(schema.users),
  ]);
  const who = new Map(users.map((u) => [u.id, displayName(u)]));
  const visible = jobs.filter((j) => j.type !== "workload.logs");

  return (
    <>
      <PageHeader title={t("User activity")} description={t("Every change made to this service, who made it and how it ended.")} />
      <Card>
        {visible.length ? (
          <Table head={[t("Action"), t("By"), t("Date"), t("Result")]}>
            {visible.map((j) => (
              <tr key={j.id}>
                <Td>{t(ACTION[j.type] ?? j.type)}{j.error && <span className="block max-w-md truncate text-xs text-danger">{j.error}</span>}</Td>
                <Td className="text-body">{(j.actorId && who.get(j.actorId)) || t("System")}</Td>
                <Td className="text-body">{formatDateTime(j.createdAt, locale)}</Td>
                <Td><StatusBadge status={j.status} label={t(j.status)} /></Td>
              </tr>
            ))}
          </Table>
        ) : (
          <EmptyState title={t("Nothing here yet")} />
        )}
      </Card>
    </>
  );
}

const ACTION: Record<string, string> = {
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
