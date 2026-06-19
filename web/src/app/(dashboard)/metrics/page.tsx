"use client";

import { useEffect, useState } from "react";
import { Activity, Cpu, Database, Gauge, Wifi } from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { apiGet } from "@/lib/api";
import { PageHeader } from "@/components/page-header";
import { cn } from "@/lib/utils";

interface Metrics {
  cpu_pct: number;
  mem_used_mb: number;
  mem_total_mb: number;
  disk_used_gb: number;
  disk_total_gb: number;
  bandwidth_gb_month: number;
  requests_24h: number;
  cpu_series: number[];
}

function Bar({ value, max }: { value: number; max: number }) {
  const pct = Math.min(100, Math.round((value / max) * 100));
  return (
    <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-muted">
      <div className="h-full rounded-full bg-primary" style={{ width: `${pct}%` }} />
    </div>
  );
}

interface HistoryPoint {
  time: string;
  cpu_pct: number;
  mem_pct: number;
  disk_pct: number;
}

const SERIES = [
  { key: "cpu_pct", label: "CPU", color: "#6366f1" },
  { key: "mem_pct", label: "Memory", color: "#10b981" },
  { key: "disk_pct", label: "Disk", color: "#f59e0b" },
] as const;

const RANGES = [
  { hours: 24, label: "24h" },
  { hours: 168, label: "7d" },
  { hours: 720, label: "30d" },
];

function fmtTime(t: string) {
  return new Date(t).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// Hand-rolled multi-line area chart (CPU / Memory / Disk, 0–100%).
function HistoryChart({ points }: { points: HistoryPoint[] }) {
  const w = 760,
    h = 200,
    padL = 26,
    padR = 8,
    padT = 8,
    padB = 8;
  const iw = w - padL - padR;
  const ih = h - padT - padB;
  const n = points.length;
  const x = (i: number) => padL + (n <= 1 ? 0 : (i / (n - 1)) * iw);
  const y = (v: number) => padT + ih - (Math.min(100, Math.max(0, v)) / 100) * ih;
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="h-52 w-full">
      {[0, 50, 100].map((g) => (
        <g key={g}>
          <line x1={padL} x2={w - padR} y1={y(g)} y2={y(g)} stroke="var(--color-border)" strokeWidth="1" />
          <text x={padL - 5} y={y(g) + 3} textAnchor="end" fill="var(--color-muted-foreground)" fontSize="9">
            {g}
          </text>
        </g>
      ))}
      {SERIES.map((s) => (
        <polyline
          key={s.key}
          points={points.map((p, i) => `${x(i)},${y(p[s.key])}`).join(" ")}
          fill="none"
          stroke={s.color}
          strokeWidth="1.5"
          strokeLinejoin="round"
        />
      ))}
    </svg>
  );
}

export default function MetricsPage() {
  const [m, setM] = useState<Metrics | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<HistoryPoint[]>([]);
  const [hours, setHours] = useState(24);

  useEffect(() => {
    apiGet<{ metrics: Metrics }>("/api/v1/metrics")
      .then((r) => setM(r.metrics))
      .catch((e) => setError(e instanceof Error ? e.message : "Failed to load"));
  }, []);

  useEffect(() => {
    apiGet<{ points: HistoryPoint[] }>(`/api/v1/metrics/history?hours=${hours}`)
      .then((r) => setHistory(r.points ?? []))
      .catch(() => setHistory([]));
  }, [hours]);

  return (
    <div className="space-y-6">
      <PageHeader title={"Metrics"} description={"Fleet resource usage. Backed by Prometheus / OpenTelemetry in production."} />

      {error && <p className="text-sm text-red-600">{error}</p>}
      {!m ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Card>
              <CardHeader className="flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">CPU</CardTitle>
                <Cpu className="h-4 w-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-semibold">{m.cpu_pct}%</div>
                <Bar value={m.cpu_pct} max={100} />
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">Memory</CardTitle>
                <Gauge className="h-4 w-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-semibold">
                  {(m.mem_used_mb / 1024).toFixed(1)}
                  <span className="text-sm text-muted-foreground"> / {(m.mem_total_mb / 1024).toFixed(0)} GB</span>
                </div>
                <Bar value={m.mem_used_mb} max={m.mem_total_mb} />
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">Disk</CardTitle>
                <Database className="h-4 w-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-semibold">
                  {m.disk_used_gb}
                  <span className="text-sm text-muted-foreground"> / {m.disk_total_gb} GB</span>
                </div>
                <Bar value={m.disk_used_gb} max={m.disk_total_gb} />
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">Bandwidth</CardTitle>
                <Wifi className="h-4 w-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-semibold">
                  {m.bandwidth_gb_month}
                  <span className="text-sm text-muted-foreground"> GB / mo</span>
                </div>
                <p className="mt-2 text-xs text-muted-foreground">
                  {(m.requests_24h / 1000).toFixed(0)}k requests / 24h
                </p>
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader className="flex-row items-center justify-between gap-2 space-y-0">
              <div className="flex items-center gap-2">
                <Activity className="h-4 w-4 text-muted-foreground" />
                <CardTitle className="text-base">Resource history</CardTitle>
              </div>
              <div className="flex gap-1">
                {RANGES.map((rng) => (
                  <button
                    key={rng.hours}
                    onClick={() => setHours(rng.hours)}
                    className={cn(
                      "rounded-md px-2 py-1 text-xs font-medium transition-colors",
                      hours === rng.hours
                        ? "bg-primary text-primary-foreground"
                        : "text-muted-foreground hover:bg-muted",
                    )}
                  >
                    {rng.label}
                  </button>
                ))}
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex flex-wrap gap-4 text-xs text-muted-foreground">
                {SERIES.map((s) => (
                  <span key={s.key} className="flex items-center gap-1.5">
                    <span className="h-2 w-2 rounded-full" style={{ backgroundColor: s.color }} />
                    {s.label}
                  </span>
                ))}
              </div>
              {history.length === 0 ? (
                <p className="py-10 text-center text-sm text-muted-foreground">
                  No samples in this range yet.
                </p>
              ) : (
                <>
                  <HistoryChart points={history} />
                  <div className="flex justify-between text-[11px] text-muted-foreground">
                    <span>{fmtTime(history[0].time)}</span>
                    <span>{fmtTime(history[history.length - 1].time)}</span>
                  </div>
                </>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
