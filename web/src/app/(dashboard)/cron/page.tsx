"use client";

import { useEffect, useState, type FormEvent } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { StatusBadge } from "@/components/ui/badge";
import { apiGet, apiPost } from "@/lib/api";
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

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await apiPost("/api/v1/cron", { schedule, command });
      setCommand("");
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
        title="Cron Jobs"
        description="Scheduled commands run in the site's container with resource limits."
      />

      {error && <p className="text-sm text-red-400">{error}</p>}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">New job</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={onCreate} className="grid gap-4 sm:grid-cols-6 sm:items-end">
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="schedule">Schedule (cron)</Label>
              <Input id="schedule" value={schedule} onChange={(e) => setSchedule(e.target.value)} className="font-mono" required />
            </div>
            <div className="space-y-1.5 sm:col-span-3">
              <Label htmlFor="command">Command</Label>
              <Input id="command" value={command} onChange={(e) => setCommand(e.target.value)} placeholder="php artisan schedule:run" className="font-mono" required />
            </div>
            <Button type="submit" disabled={busy}>
              {busy ? "Adding…" : "Add"}
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
              </tr>
            </thead>
            <tbody>
              {jobs.map((j) => (
                <tr key={j.id} className="border-b border-border/60 last:border-0">
                  <td className="px-6 py-3 font-mono text-xs">{j.schedule}</td>
                  <td className="px-6 py-3 font-mono text-xs text-muted-foreground">{j.command}</td>
                  <td className="px-6 py-3 text-muted-foreground">
                    {j.last_run ? new Date(j.last_run).toLocaleString() : "—"}
                  </td>
                  <td className="px-6 py-3">
                    <StatusBadge status={j.status === "ok" ? "active" : j.status} />
                  </td>
                  <td className="px-6 py-3 text-muted-foreground">{j.enabled ? "on" : "off"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}
