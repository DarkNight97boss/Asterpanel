"use client";

import { useEffect, useState } from "react";
import { Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { StatusBadge } from "@/components/ui/badge";
import { apiDelete, apiGet, apiPost, createBackup, listBackups, type Backup } from "@/lib/api";
import { PageHeader } from "@/components/page-header";

const TYPES = ["full", "files", "database"];

interface Schedule {
  id: string;
  frequency: "daily" | "weekly";
  retention_days: number;
  enabled: boolean;
  last_run_at: string | null;
}

function fmtBytes(b: number | null) {
  if (b == null) return "—";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let n = b;
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(1)} ${u[i]}`;
}

export default function BackupsPage() {
  const [backups, setBackups] = useState<Backup[]>([]);
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [type, setType] = useState("full");
  const [freq, setFreq] = useState("daily");
  const [retention, setRetention] = useState("30");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function refresh() {
    try {
      const [b, s] = await Promise.all([
        listBackups(),
        apiGet<{ schedules: Schedule[] }>("/api/v1/backup-schedules"),
      ]);
      setBackups(b);
      setSchedules(s.schedules ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    }
  }
  useEffect(() => {
    refresh();
  }, []);

  async function addSchedule() {
    setBusy(true);
    setError(null);
    try {
      await apiPost("/api/v1/backup-schedules", {
        frequency: freq,
        retention_days: Number(retention) || 30,
      });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not create schedule");
    } finally {
      setBusy(false);
    }
  }

  async function deleteSchedule(id: string) {
    try {
      await apiDelete(`/api/v1/backup-schedules/${id}`);
      setSchedules((prev) => prev.filter((s) => s.id !== id));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not delete schedule");
    }
  }

  async function onCreate() {
    setBusy(true);
    setError(null);
    try {
      await createBackup({ type });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Create failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Backups"
        description="Manual and scheduled backups to object storage (S3/B2), encrypted, with one-click restore."
      />

      {error && <p className="text-sm text-red-400">{error}</p>}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Run a backup</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-end gap-4">
            <div className="space-y-1.5">
              <label className="text-sm font-medium" htmlFor="type">
                Type
              </label>
              <select
                id="type"
                value={type}
                onChange={(e) => setType(e.target.value)}
                className="flex h-9 w-40 rounded-md border border-border bg-transparent px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              >
                {TYPES.map((t) => (
                  <option key={t} value={t} className="bg-card">
                    {t}
                  </option>
                ))}
              </select>
            </div>
            <Button onClick={onCreate} disabled={busy}>
              {busy ? "Starting…" : "Run backup"}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Schedules ({schedules.length})</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1">
              <label className="text-sm font-medium" htmlFor="freq">
                Frequency
              </label>
              <select
                id="freq"
                value={freq}
                onChange={(e) => setFreq(e.target.value)}
                className="h-9 w-40 rounded-md border border-border bg-transparent px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              >
                <option value="daily" className="bg-card">
                  daily
                </option>
                <option value="weekly" className="bg-card">
                  weekly
                </option>
              </select>
            </div>
            <div className="space-y-1">
              <label className="text-sm font-medium" htmlFor="retention">
                Retention (days)
              </label>
              <input
                id="retention"
                type="number"
                min={1}
                value={retention}
                onChange={(e) => setRetention(e.target.value)}
                className="h-9 w-32 rounded-md border border-input bg-background px-3 text-sm"
              />
            </div>
            <Button variant="outline" size="sm" disabled={busy} onClick={addSchedule}>
              Add schedule
            </Button>
          </div>
          {schedules.length > 0 && (
            <div className="divide-y divide-border/60 rounded-md border border-border/60">
              {schedules.map((s) => (
                <div key={s.id} className="flex items-center gap-3 px-4 py-2 text-sm">
                  <span className="font-medium capitalize">{s.frequency}</span>
                  <span className="text-muted-foreground">retain {s.retention_days}d</span>
                  <span className="text-xs text-muted-foreground">
                    last run {s.last_run_at ? new Date(s.last_run_at).toLocaleString() : "never"}
                  </span>
                  <button
                    className="ml-auto text-muted-foreground hover:text-red-400"
                    onClick={() => deleteSchedule(s.id)}
                    aria-label="Delete schedule"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">History ({backups.length})</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <table className="w-full text-sm">
            <thead className="border-b border-border text-left text-muted-foreground">
              <tr>
                <th className="px-6 py-3 font-medium">Type</th>
                <th className="px-6 py-3 font-medium">Trigger</th>
                <th className="px-6 py-3 font-medium">Status</th>
                <th className="px-6 py-3 font-medium">Size</th>
                <th className="px-6 py-3 font-medium">Checksum</th>
                <th className="px-6 py-3 font-medium">Storage</th>
                <th className="px-6 py-3 font-medium">When</th>
              </tr>
            </thead>
            <tbody>
              {backups.map((b) => (
                <tr key={b.id} className="border-b border-border/60 last:border-0">
                  <td className="px-6 py-3 capitalize">{b.type}</td>
                  <td className="px-6 py-3 text-muted-foreground">{b.trigger}</td>
                  <td className="px-6 py-3">
                    <StatusBadge status={b.status === "completed" ? "active" : b.status} />
                  </td>
                  <td className="px-6 py-3 text-muted-foreground">{fmtBytes(b.size_bytes)}</td>
                  <td className="px-6 py-3 font-mono text-xs text-muted-foreground" title={b.checksum ?? ""}>
                    {b.checksum ? `${b.checksum.slice(0, 12)}…` : "—"}
                  </td>
                  <td className="px-6 py-3 font-mono text-xs uppercase text-muted-foreground">
                    {b.storage_backend}
                  </td>
                  <td className="px-6 py-3 text-muted-foreground">
                    {new Date(b.created_at).toLocaleString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}
