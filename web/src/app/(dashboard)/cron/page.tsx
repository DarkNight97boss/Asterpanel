"use client";

import { useEffect, useState, type FormEvent } from "react";
import { Pencil, Power, Trash2, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { StatusBadge } from "@/components/ui/badge";
import { apiDelete, apiGet, apiPost } from "@/lib/api";
import { PageHeader } from "@/components/page-header";

interface CronJob {
  id: string;
  schedule: string;
  command: string;
  last_run: string | null;
  status: string;
  enabled: boolean;
}

export default function CronPage() {
  const [jobs, setJobs] = useState<CronJob[]>([]);
  const [editId, setEditId] = useState<string | null>(null);
  const [schedule, setSchedule] = useState("0 3 * * *");
  const [command, setCommand] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    try {
      const { jobs } = await apiGet<{ jobs: CronJob[] }>("/api/v1/cron");
      setJobs(jobs);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    }
  }
  useEffect(() => {
    refresh();
  }, []);

  function resetForm() {
    setEditId(null);
    setSchedule("0 3 * * *");
    setCommand("");
  }

  function startEdit(j: CronJob) {
    setEditId(j.id);
    setSchedule(j.schedule);
    setCommand(j.command);
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (editId) {
        await apiPost(`/api/v1/cron/${editId}`, { schedule, command });
      } else {
        await apiPost("/api/v1/cron", { schedule, command });
      }
      resetForm();
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setBusy(false);
    }
  }

  async function toggleEnabled(j: CronJob) {
    setError(null);
    try {
      await apiPost(`/api/v1/cron/${j.id}`, {
        schedule: j.schedule,
        command: j.command,
        enabled: !j.enabled,
      });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not toggle job");
    }
  }

  async function onDelete(id: string) {
    setError(null);
    try {
      await apiDelete(`/api/v1/cron/${id}`);
      if (editId === id) resetForm();
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Delete failed");
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Cron Jobs"
        description="Scheduled commands run in the site's container with resource limits."
      />

      {error && <p className="text-sm text-red-600">{error}</p>}

      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <CardTitle className="text-base">{editId ? "Edit job" : "New job"}</CardTitle>
          {editId && (
            <Button variant="ghost" size="sm" onClick={resetForm}>
              <X className="h-4 w-4" />
              Cancel
            </Button>
          )}
        </CardHeader>
        <CardContent>
          <form onSubmit={onSubmit} className="grid gap-4 sm:grid-cols-6 sm:items-end">
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="schedule">Schedule (cron)</Label>
              <Input id="schedule" value={schedule} onChange={(e) => setSchedule(e.target.value)} className="font-mono" required />
            </div>
            <div className="space-y-1.5 sm:col-span-3">
              <Label htmlFor="command">Command</Label>
              <Input id="command" value={command} onChange={(e) => setCommand(e.target.value)} placeholder="php artisan schedule:run" className="font-mono" required />
            </div>
            <Button type="submit" disabled={busy}>
              {busy ? "Saving…" : editId ? "Save" : "Add"}
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Jobs ({jobs.length})</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <table className="w-full text-sm">
            <thead className="border-b border-border text-left text-muted-foreground">
              <tr>
                <th className="px-6 py-3 font-medium">Schedule</th>
                <th className="px-6 py-3 font-medium">Command</th>
                <th className="px-6 py-3 font-medium">Last run</th>
                <th className="px-6 py-3 font-medium">Status</th>
                <th className="px-6 py-3 font-medium">Enabled</th>
                <th className="px-6 py-3" />
              </tr>
            </thead>
            <tbody>
              {jobs.map((j) => (
                <tr
                  key={j.id}
                  className={`border-b border-border/60 last:border-0 ${editId === j.id ? "bg-muted/60" : ""}`}
                >
                  <td className="px-6 py-3 font-mono text-xs">{j.schedule}</td>
                  <td className="px-6 py-3 font-mono text-xs text-muted-foreground">{j.command}</td>
                  <td className="px-6 py-3 text-muted-foreground">
                    {j.last_run ? new Date(j.last_run).toLocaleString() : "—"}
                  </td>
                  <td className="px-6 py-3">
                    <StatusBadge status={j.status === "ok" ? "active" : j.status} />
                  </td>
                  <td className="px-6 py-3 text-muted-foreground">{j.enabled ? "on" : "off"}</td>
                  <td className="px-6 py-3 text-right">
                    <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => toggleEnabled(j)} aria-label="Toggle enabled" title={j.enabled ? "Disable" : "Enable"}>
                      <Power className={`h-4 w-4 ${j.enabled ? "text-emerald-500" : "text-muted-foreground"}`} />
                    </Button>
                    <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => startEdit(j)} aria-label="Edit">
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => onDelete(j.id)} aria-label="Delete">
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </td>
                </tr>
              ))}
              {jobs.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-6 py-8 text-center text-muted-foreground">
                    No cron jobs yet.
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
