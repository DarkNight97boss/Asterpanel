"use client";

import { useEffect, useState } from "react";
import { CalendarClock, History, Pencil, Play, Power, RotateCcw, Trash2, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { StatusBadge } from "@/components/ui/badge";
import { apiDelete, apiGet, apiPost, createBackup, listBackups, type Backup } from "@/lib/api";
import { PageHeader } from "@/components/page-header";
import { PageTabs, type PageTab } from "@/components/page-tabs";

const TYPES = ["full", "files", "database"];

const TABS: PageTab[] = [
  { id: "run", label: "Run Backup", icon: Play },
  { id: "schedules", label: "Schedules", icon: CalendarClock },
  { id: "history", label: "History", icon: History },
];

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
  const [editSchedId, setEditSchedId] = useState<string | null>(null);
  const [tab, setTab] = useState("run");
  const [confirmRestore, setConfirmRestore] = useState<string | null>(null);
  const [restoreNotice, setRestoreNotice] = useState<string | null>(null);
  const [restoreBusy, setRestoreBusy] = useState(false);

  async function doRestore(id: string) {
    setRestoreBusy(true);
    setError(null);
    setRestoreNotice(null);
    try {
      await apiPost(`/api/v1/backups/${id}/restore`, {});
      setConfirmRestore(null);
      setRestoreNotice("Restore dispatched to the node — the artifact is verified against its checksum before files are overwritten.");
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not start restore");
    } finally {
      setRestoreBusy(false);
    }
  }

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

  function startEditSchedule(s: Schedule) {
    setEditSchedId(s.id);
    setFreq(s.frequency);
    setRetention(String(s.retention_days));
  }
  function cancelEditSchedule() {
    setEditSchedId(null);
    setFreq("daily");
    setRetention("30");
  }

  async function addSchedule() {
    setBusy(true);
    setError(null);
    try {
      if (editSchedId) {
        const cur = schedules.find((s) => s.id === editSchedId);
        await apiPost(`/api/v1/backup-schedules/${editSchedId}`, {
          frequency: freq,
          retention_days: Number(retention) || 30,
          enabled: cur ? cur.enabled : true,
        });
        setEditSchedId(null);
      } else {
        await apiPost("/api/v1/backup-schedules", {
          frequency: freq,
          retention_days: Number(retention) || 30,
        });
      }
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save schedule");
    } finally {
      setBusy(false);
    }
  }

  async function toggleSchedule(s: Schedule) {
    setError(null);
    try {
      await apiPost(`/api/v1/backup-schedules/${s.id}`, {
        frequency: s.frequency,
        retention_days: s.retention_days,
        enabled: !s.enabled,
      });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not toggle schedule");
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

      {error && <p className="text-sm text-red-600">{error}</p>}

      <PageTabs tabs={TABS} active={tab} onChange={setTab} />

      {tab === "run" && (
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
      )}

      {tab === "schedules" && (
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
              {busy ? "Saving…" : editSchedId ? "Save schedule" : "Add schedule"}
            </Button>
            {editSchedId && (
              <Button variant="ghost" size="icon" className="h-9 w-9" onClick={cancelEditSchedule} aria-label="Cancel">
                <X className="h-4 w-4" />
              </Button>
            )}
          </div>
          {schedules.length > 0 && (
            <div className="divide-y divide-border/60 rounded-md border border-border/60">
              {schedules.map((s) => (
                <div key={s.id} className={`flex items-center gap-3 px-4 py-2 text-sm ${editSchedId === s.id ? "bg-muted/60" : ""}`}>
                  <span className="font-medium capitalize">{s.frequency}</span>
                  <span className="text-muted-foreground">retain {s.retention_days}d</span>
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                      s.enabled
                        ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
                        : "bg-muted text-muted-foreground"
                    }`}
                  >
                    {s.enabled ? "on" : "paused"}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    last run {s.last_run_at ? new Date(s.last_run_at).toLocaleString() : "never"}
                  </span>
                  <Button variant="ghost" size="icon" className="ml-auto h-7 w-7" onClick={() => toggleSchedule(s)} aria-label="Toggle schedule" title={s.enabled ? "Pause" : "Resume"}>
                    <Power className={`h-4 w-4 ${s.enabled ? "text-emerald-500" : "text-muted-foreground"}`} />
                  </Button>
                  <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => startEditSchedule(s)} aria-label="Edit schedule">
                    <Pencil className="h-4 w-4" />
                  </Button>
                  <button
                    className="text-muted-foreground hover:text-red-600"
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
      )}

      {tab === "history" && (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">History ({backups.length})</CardTitle>
        </CardHeader>
        <CardContent className="space-y-0 p-0">
          {restoreNotice && (
            <p className="px-6 pt-4 text-sm text-emerald-600">{restoreNotice}</p>
          )}
          {confirmRestore && (
            <div className="mx-6 mt-4 rounded-md border border-amber-500/40 bg-amber-500/5 px-4 py-3 text-sm">
              <p className="font-medium text-amber-700 dark:text-amber-400">Restore this backup?</p>
              <p className="mt-0.5 text-muted-foreground">
                The node downloads the artifact (from S3 if the local copy is gone), verifies its
                checksum, then overwrites the live site directory. This can&apos;t be undone.
              </p>
              <div className="mt-2 flex items-center gap-2">
                <Button variant="destructive" size="sm" disabled={restoreBusy} onClick={() => doRestore(confirmRestore)}>
                  {restoreBusy ? "Starting…" : "Restore now"}
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setConfirmRestore(null)}>
                  Cancel
                </Button>
              </div>
            </div>
          )}
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
                <th className="px-6 py-3" />
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
                  <td className="px-6 py-3 text-right">
                    {b.status === "completed" && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          setRestoreNotice(null);
                          setConfirmRestore(b.id);
                        }}
                      >
                        <RotateCcw className="h-4 w-4" />
                        Restore
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>
      )}
    </div>
  );
}
