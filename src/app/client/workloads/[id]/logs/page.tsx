import { and, eq } from "drizzle-orm";
import { AutoRefresh } from "@/components/auto-refresh";
import { Button, Card, CardHeader } from "@/components/ui";
import { getDb, schema } from "@/db";
import { getT } from "@/i18n";
import { requireWorkload } from "@/platform/access";
import { LiveLogs } from "@/components/live-logs";
import { fetchLogs } from "../../../platform-actions";

export default async function Logs({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ job?: string; live?: string }> }) {
  const { workload: w } = await requireWorkload((await params).id);
  const sp = await searchParams;
  const jobId = sp.job ?? "";
  const live = sp.live === "1";
  const db = await getDb();
  const t = await getT();
  const [job] = /^[0-9a-f-]{36}$/i.test(jobId)
    ? await db.select().from(schema.jobs).where(and(eq(schema.jobs.id, jobId), eq(schema.jobs.workloadId, w.id), eq(schema.jobs.type, "workload.logs")))
    : [];
  const pending = job?.status === "queued" || job?.status === "running";

  return (
    <Card className="overflow-hidden">
      <AutoRefresh active={pending} intervalMs={1500} />
      {/* Live: once the current fetch is shown, ask for the next one a few seconds later. */}
      {live && !pending && w.status === "running" && <LiveLogs workloadId={w.id} />}
      <CardHeader
        title={t("Container logs")}
        description={t("Last 300 lines, fetched from the server on demand.")}
        action={
          <form action={fetchLogs} className="flex items-center gap-2">
            <input type="hidden" name="id" value={w.id} />
            <label className="flex items-center gap-1.5 text-sm text-muted"><input type="checkbox" name="live" value="1" defaultChecked={live} className="accent-(--accent)" />{t("Live")}</label>
            <Button variant="secondary" disabled={pending || w.status === "creating"}>{pending ? t("Fetching logs…") : job ? t("Refresh") : t("Load logs")}</Button>
          </form>
        }
      />
      <pre className="max-h-[65vh] min-h-40 overflow-auto bg-ink p-5 font-mono text-xs leading-relaxed text-ink-fg">
        {job?.status === "failed" ? job.error : job?.status === "succeeded" ? String(job.result.output ?? "") || t("No output yet.") : pending ? "…" : t("Press “Load logs” to fetch the latest output.")}
      </pre>
    </Card>
  );
}
