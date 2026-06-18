"use client";

import { useEffect, useState } from "react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { apiGet, listWebsites, type Website } from "@/lib/api";
import { PageHeader } from "@/components/page-header";

interface Analytics {
  requests: number;
  visitors: number;
  bytes: number;
  top_paths: { path: string; count: number }[];
  status_classes: Record<"2xx" | "3xx" | "4xx" | "5xx", number>;
  log_present: boolean;
}

const selectCls =
  "flex h-9 w-full max-w-xs rounded-md border border-border bg-transparent px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary";

function fmtBytes(b: number) {
  if (b < 1024) return `${b} B`;
  if (b < 1024 ** 2) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 ** 3) return `${(b / 1024 ** 2).toFixed(1)} MB`;
  return `${(b / 1024 ** 3).toFixed(2)} GB`;
}

const STATUS_META: Record<string, { label: string; color: string }> = {
  "2xx": { label: "2xx success", color: "bg-emerald-500" },
  "3xx": { label: "3xx redirect", color: "bg-sky-500" },
  "4xx": { label: "4xx client", color: "bg-amber-500" },
  "5xx": { label: "5xx server", color: "bg-red-500" },
};

export default function AnalyticsPage() {
  const [sites, setSites] = useState<Website[]>([]);
  const [siteId, setSiteId] = useState("");
  const [data, setData] = useState<Analytics | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    listWebsites()
      .then((ws) => {
        setSites(ws);
        if (ws.length) setSiteId(ws[0].id);
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Failed to load sites"));
  }, []);

  useEffect(() => {
    if (!siteId) return;
    setLoading(true);
    setError(null);
    apiGet<Analytics>(`/api/v1/sites/${siteId}/analytics`)
      .then(setData)
      .catch((e) => {
        setData(null);
        setError(e instanceof Error ? e.message : "Failed to load analytics");
      })
      .finally(() => setLoading(false));
  }, [siteId]);

  const totalStatus = data
    ? Object.values(data.status_classes).reduce((a, b) => a + b, 0) || 1
    : 1;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Web analytics"
        description="Per-site traffic from the access log: requests, unique visitors, bandwidth and top pages."
      />

      <div className="flex items-center gap-3">
        <label htmlFor="site" className="text-sm text-muted-foreground">
          Site
        </label>
        <select
          id="site"
          className={selectCls}
          value={siteId}
          onChange={(e) => setSiteId(e.target.value)}
        >
          {sites.length === 0 && <option value="">No sites</option>}
          {sites.map((s) => (
            <option key={s.id} value={s.id} className="bg-card">
              {s.name ?? s.id}
            </option>
          ))}
        </select>
      </div>

      {error && <p className="text-sm text-red-400">{error}</p>}

      {data && !data.log_present && (
        <p className="text-sm text-muted-foreground">
          No access log on the node yet — figures will populate once the site receives traffic.
        </p>
      )}

      <div className="grid gap-4 sm:grid-cols-3">
        {[
          { label: "Requests", value: data ? data.requests.toLocaleString() : "—" },
          { label: "Unique visitors", value: data ? data.visitors.toLocaleString() : "—" },
          { label: "Bandwidth", value: data ? fmtBytes(data.bytes) : "—" },
        ].map((stat) => (
          <Card key={stat.label}>
            <CardContent className="pt-6">
              <p className="text-xs uppercase tracking-wide text-muted-foreground">{stat.label}</p>
              <p className="mt-1 text-2xl font-semibold">{loading ? "…" : stat.value}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Status codes</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {data ? (
            (["2xx", "3xx", "4xx", "5xx"] as const).map((k) => {
              const count = data.status_classes[k] ?? 0;
              const pct = Math.round((count / totalStatus) * 100);
              return (
                <div key={k} className="flex items-center gap-3 text-sm">
                  <span className="w-24 text-muted-foreground">{STATUS_META[k].label}</span>
                  <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
                    <div
                      className={`h-full rounded-full ${STATUS_META[k].color}`}
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                  <span className="w-16 text-right font-mono text-xs text-muted-foreground">
                    {count.toLocaleString()}
                  </span>
                </div>
              );
            })
          ) : (
            <p className="text-sm text-muted-foreground">No data.</p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Top pages</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <table className="w-full text-sm">
            <thead className="border-b border-border text-left text-muted-foreground">
              <tr>
                <th className="px-6 py-3 font-medium">Path</th>
                <th className="px-6 py-3 text-right font-medium">Requests</th>
              </tr>
            </thead>
            <tbody>
              {data && data.top_paths.length > 0 ? (
                data.top_paths.map((p) => (
                  <tr key={p.path} className="border-b border-border/60 last:border-0">
                    <td className="px-6 py-2.5 font-mono text-xs">{p.path}</td>
                    <td className="px-6 py-2.5 text-right text-muted-foreground">
                      {p.count.toLocaleString()}
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td className="px-6 py-3 text-muted-foreground" colSpan={2}>
                    No requests recorded yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}
