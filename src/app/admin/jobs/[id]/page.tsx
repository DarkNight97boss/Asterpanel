import Link from "next/link";
import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import { AutoRefresh } from "@/components/auto-refresh";
import { Alert, Card, PageHeader, StatusBadge } from "@/components/ui";
import { getDb, schema } from "@/db";
import { getT } from "@/i18n";
import { requireArea } from "@/lib/auth";

export default async function JobDetail({ params }: { params: Promise<{ id: string }> }) {
  await requireArea("platform");
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const db = await getDb();
  const [job, t] = await Promise.all([db.query.jobs.findFirst({ where: eq(schema.jobs.id, id), with: { node: true, workload: true } }), getT()]);
  if (!job) notFound();
  return (
    <>
      <AutoRefresh active={job.status === "queued" || job.status === "running"} intervalMs={1500} />
      <PageHeader
        title={<span className="font-mono text-xl">{job.type}</span>}
        description={<><StatusBadge status={job.status} label={t(job.status)} /> {job.workload?.name} · {job.node.name}</>}
        action={<Link href="/admin/jobs" className="text-sm text-link">← {t("Jobs")}</Link>}
      />
      {job.error && <div className="mb-4"><Alert tone="danger">{job.error}</Alert></div>}
      <Card className="overflow-hidden">
        <pre className="max-h-[70vh] overflow-auto bg-ink p-5 font-mono text-xs leading-relaxed text-ink-fg">{job.log || t("No output yet.")}</pre>
      </Card>
    </>
  );
}
