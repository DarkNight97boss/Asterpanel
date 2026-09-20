import { and, asc, eq, gte } from "drizzle-orm";
import { Button, Card, CardHeader, EmptyState, PageHeader, Select } from "@/components/ui";
import { recentMonths } from "@/lib/site-report";
import { getDb, schema } from "@/db";
import { getLocale, getT } from "@/i18n";
import { requireWorkload } from "@/platform/access";
import { uptimeSummary } from "@/platform/uptime";

type Point = { at: Date; v: number };

/** Dependency-free area chart. */
function Chart({ points, unit, max }: { points: Point[]; unit: string; max?: number }) {
  const W = 640, H = 160, top = Math.max(max ?? 0, ...points.map((p) => p.v), 1);
  const t0 = points[0].at.getTime(), span = Math.max(points.at(-1)!.at.getTime() - t0, 1);
  const xy = points.map((p) => [((p.at.getTime() - t0) / span) * W, H - (p.v / top) * (H - 12)] as const);
  const line = xy.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`).join(" ");
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label={`max ${Math.round(top)} ${unit}`}>
      {[0.25, 0.5, 0.75].map((f) => <line key={f} x1="0" x2={W} y1={H * f} y2={H * f} stroke="var(--border)" strokeDasharray="3 5" />)}
      <path d={`${line} L${W} ${H} L0 ${H}Z`} fill="var(--accent)" opacity="0.1" />
      <path d={line} fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

export default async function Analytics({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ range?: string }> }) {
  const { workload: w } = await requireWorkload((await params).id);
  const hours = (await searchParams).range === "7d" ? 168 : 24;
  const db = await getDb();
  const [t, locale, rows] = await Promise.all([
    getT(),
    getLocale(),
    db.select().from(schema.workloadMetrics).where(and(eq(schema.workloadMetrics.workloadId, w.id), gte(schema.workloadMetrics.at, hoursAgo(hours)))).orderBy(asc(schema.workloadMetrics.at)),
  ]);
  const uptime = w.type === "database" ? null : await uptimeSummary(w.id);
  const base = `/client/workloads/${w.id}/analytics`;
  // Network counters are cumulative: chart the traffic between samples.
  const delta = (key: "txMb" | "rxMb"): Point[] => rows.slice(1).map((r, i) => ({ at: r.at, v: Math.max(0, r[key] - rows[i][key]) }));
  const sum = (pts: Point[]) => pts.reduce((a, p) => a + p.v, 0);
  const avg = (key: "cpuPercent" | "memMb") => Math.round(rows.reduce((a, r) => a + r[key], 0) / Math.max(rows.length, 1));
  const num = (n: number) => new Intl.NumberFormat(locale).format(n);

  const charts: { title: string; value: string; points: Point[]; unit: string; max?: number }[] = [
    { title: t("CPU usage"), value: `${avg("cpuPercent")}% ${t("average")}`, points: rows.map((r) => ({ at: r.at, v: r.cpuPercent })), unit: "%", max: 100 },
    { title: t("Memory usage"), value: `${num(avg("memMb"))} MB ${t("average")}`, points: rows.map((r) => ({ at: r.at, v: r.memMb })), unit: "MB", max: w.config.memoryMb },
    { title: t("Bandwidth out"), value: `${num(sum(delta("txMb")))} MB`, points: delta("txMb"), unit: "MB" },
    { title: t("Bandwidth in"), value: `${num(sum(delta("rxMb")))} MB`, points: delta("rxMb"), unit: "MB" },
  ];

  return (
    <>
      <PageHeader
        title={t("Analytics")}
        action={
          <div className="flex rounded-theme border border-border bg-surface p-0.5 text-sm">
            {([["24h", t("Last 24 hours")], ["7d", t("Last 7 days")]] as const).map(([key, label]) => (
              <a key={key} href={`${base}?range=${key}`} className={`rounded-md px-3 py-1.5 ${(hours === 168) === (key === "7d") ? "bg-border font-medium text-fg" : "text-body hover:text-fg"}`}>{label}</a>
            ))}
          </div>
        }
      />
      {uptime && (
        <Card className="mb-6 p-6">
          <div className="flex flex-wrap items-baseline justify-between gap-4">
            <h2 className="text-xl font-medium">{t("Uptime")}</h2>
            <span className="text-sm text-muted">{t("Checked from outside every 5 minutes, last 7 days")}</span>
          </div>
          {uptime.checks ? (
            <div className="mt-4 grid gap-6 sm:grid-cols-3">
              <div><p className="font-display text-4xl">{uptime.percent}%</p><p className="text-sm text-muted">{t("Availability")}</p></div>
              <div><p className="font-display text-4xl">{uptime.avgMs ?? "—"} ms</p><p className="text-sm text-muted">{t("Average response")}</p></div>
              <div>
                <p className={`text-lg font-medium ${uptime.last?.ok ? "text-success" : "text-danger"}`}>{uptime.last?.ok ? t("Online") : t("Not responding")}</p>
                {uptime.recentFailures.length > 0 && <p className="mt-1 text-xs text-muted">{t("Last failure")}: {uptime.recentFailures[0].at.toISOString().slice(0, 16).replace("T", " ")} · {uptime.recentFailures[0].error || `HTTP ${uptime.recentFailures[0].status}`}</p>}
              </div>
            </div>
          ) : (
            <p className="mt-3 text-sm text-muted">{t("No checks yet. Monitoring starts with the next scheduled run.")}</p>
          )}
        </Card>
      )}
      {rows.length < 2 ? (
        <Card><EmptyState title={t("Collecting data…")} description={t("The server reports resource usage every few minutes. Charts appear after the first samples.")} /></Card>
      ) : (
        <div className="grid gap-6 lg:grid-cols-2">
          {charts.map((c) => (
            <Card key={c.title} className="p-6">
              <div className="mb-4 flex items-baseline justify-between gap-4">
                <h2 className="text-xl font-medium">{c.title}</h2>
                <span className="text-sm text-muted">{c.value}</span>
              </div>
              {c.points.length > 1 ? <Chart points={c.points} unit={c.unit} max={c.max} /> : <p className="py-10 text-center text-sm text-muted">—</p>}
            </Card>
          ))}
        </div>
      )}
      {w.type !== "database" && (
        <div className="mt-6">
          <Card>
            <CardHeader title={t("Monthly report")} description={t("A PDF with the month's availability, backups, deployments and security, ready to hand to your customer.")} />
            <form method="get" action={`/client/workloads/${w.id}/report`} className="flex flex-wrap items-center gap-3 p-5 pt-0">
              <Select name="month" className="w-auto">{recentMonths(12).map((m) => <option key={m} value={m}>{m}</option>)}</Select>
              <Button variant="secondary">{t("Download PDF")}</Button>
            </form>
          </Card>
        </div>
      )}
    </>
  );
}

/** Server components render once per request: reading the clock here is fine. */
const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000);
