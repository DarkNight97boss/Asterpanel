import { and, eq } from "drizzle-orm";
import { AutoRefresh } from "@/components/auto-refresh";
import { Alert, Button, Card, CardHeader, EmptyState, PageHeader, Select, Stat, Table, Td } from "@/components/ui";
import { getDb, schema } from "@/db";
import { getLocale, getT } from "@/i18n";
import { requireWorkload } from "@/platform/access";
import { APM_RANGES } from "@/platform/engine";
import type { ApmReport } from "@/platform/protocol";
import { analysePerformance } from "../../../platform-actions";

const RANGE_LABEL: Record<number, string> = { 15: "Last 15 minutes", 60: "Last hour", 360: "Last 6 hours", 1440: "Last 24 hours" };

export default async function Apm({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ job?: string }> }) {
  const { workload: w } = await requireWorkload((await params).id);
  const jobId = (await searchParams).job ?? "";
  const db = await getDb();
  const [t, locale] = await Promise.all([getT(), getLocale()]);
  const [job] = /^[0-9a-f-]{36}$/i.test(jobId)
    ? await db.select().from(schema.jobs).where(and(eq(schema.jobs.id, jobId), eq(schema.jobs.workloadId, w.id), eq(schema.jobs.type, "workload.apm")))
    : [];
  const pending = job?.status === "queued" || job?.status === "running";
  let report: ApmReport | null = null;
  if (job?.status === "succeeded" && typeof job.result.output === "string") {
    try {
      report = JSON.parse(job.result.output) as ApmReport;
    } catch {}
  }
  const num = (n: number) => new Intl.NumberFormat(locale).format(n);
  const ms = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(2)} s` : `${num(n)} ms`);
  const total = report ? Math.max(report.requests, 1) : 1;
  const tone = (n: number) => (n >= 1500 ? "text-danger" : n >= 600 ? "text-warning" : "text-fg");

  return (
    <>
      <AutoRefresh active={pending} intervalMs={1500} />
      <PageHeader
        title="APM"
        description={t("Where time goes: response times measured at the edge for every request to this service.")}
        action={
          <form action={analysePerformance} className="flex items-center gap-2">
            <input type="hidden" name="id" value={w.id} />
            <Select name="minutes" defaultValue={String(report?.minutes ?? 60)} className="w-48">
              {APM_RANGES.map((m) => <option key={m} value={m}>{t(RANGE_LABEL[m])}</option>)}
            </Select>
            <Button disabled={pending || w.status !== "running"}>{pending ? t("Working…") : t("Analyse")}</Button>
          </form>
        }
      />
      {job?.status === "failed" && <div className="mb-5"><Alert tone="danger">{job.error}</Alert></div>}
      {!report ? (
        <Card><EmptyState title={pending ? t("Working…") : t("No report yet")} description={t("Pick a time range and press Analyse. Requests are measured from the moment they reach the server to the last byte sent.")} /></Card>
      ) : !report.requests ? (
        <Card><EmptyState title={t("No requests in this period")} /></Card>
      ) : (
        <div className="space-y-6">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label={t("Requests")} value={num(report.requests)} hint={t(RANGE_LABEL[report.minutes])} />
            <Stat label={t("Average response")} value={<span className={tone(report.avgMs)}>{ms(report.avgMs)}</span>} />
            <Stat label={t("95th percentile")} value={<span className={tone(report.p95Ms)}>{ms(report.p95Ms)}</span>} hint={t("19 requests out of 20 are faster than this")} />
            <Stat label={t("Server errors (5xx)")} value={<span className={report.status.serverError ? "text-danger" : ""}>{((report.status.serverError / total) * 100).toFixed(2)}%</span>} hint={`${num(report.status.clientError)} × 4xx · ${num(report.status.redirect)} × 3xx`} />
          </div>
          <div className="grid gap-6 xl:grid-cols-2">
            <Card>
              <CardHeader title={t("Slowest pages")} description={t("By average response time, at least 3 requests.")} />
              <Table head={[t("Path"), t("Requests"), t("Average"), t("Slowest")]}>
                {report.slowest.map((r) => (
                  <tr key={r.path}><Td className="max-w-xs truncate font-mono text-xs" title={r.path}>{r.path}</Td><Td>{num(r.count)}</Td><Td className={tone(r.avgMs)}>{ms(r.avgMs)}</Td><Td className="text-body">{ms(r.maxMs)}</Td></tr>
                ))}
              </Table>
            </Card>
            <Card>
              <CardHeader title={t("Most requested")} />
              <Table head={[t("Path"), t("Requests"), t("Average")]}>
                {report.busiest.map((r) => (
                  <tr key={r.path}><Td className="max-w-xs truncate font-mono text-xs" title={r.path}>{r.path}</Td><Td>{num(r.count)}</Td><Td className={tone(r.avgMs)}>{ms(r.avgMs)}</Td></tr>
                ))}
              </Table>
            </Card>
          </div>
        </div>
      )}
    </>
  );
}
