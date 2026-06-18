"use client";

import { useEffect, useState } from "react";
import { Activity, Cpu, Database, Gauge, Wifi } from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { apiGet } from "@/lib/api";
import { PageHeader } from "@/components/page-header";

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

function Sparkline({ data }: { data: number[] }) {
  const w = 600;
  const h = 80;
  const max = Math.max(...data, 1);
  const pts = data.map((v, i) => `${(i / (data.length - 1)) * w},${h - (v / max) * h}`).join(" ");
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="h-20 w-full" preserveAspectRatio="none">
      <polyline points={pts} fill="none" stroke="var(--color-primary)" strokeWidth="2" />
    </svg>
  );
}

export default function MetricsPage() {
  const [m, setM] = useState<Metrics | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiGet<{ metrics: Metrics }>("/api/v1/metrics")
      .then((r) => setM(r.metrics))
      .catch((e) => setError(e instanceof Error ? e.message : "Failed to load"));
  }, []);

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
            <CardHeader className="flex-row items-center gap-2 space-y-0">
              <Activity className="h-4 w-4 text-muted-foreground" />
              <CardTitle className="text-base">CPU — last 24h</CardTitle>
            </CardHeader>
            <CardContent>
              <Sparkline data={m.cpu_series} />
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
