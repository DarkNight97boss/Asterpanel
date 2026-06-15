"use client";

import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { StatusBadge } from "@/components/ui/badge";
import { createBackup, listBackups, type Backup } from "@/lib/api";

const TYPES = ["full", "files", "database"];

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
  const [type, setType] = useState("full");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function refresh() {
    try {
      setBackups(await listBackups());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    }
  }
  useEffect(() => {
    refresh();
  }, []);

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
      <header>
        <h1 className="text-2xl font-semibold">Backups</h1>
        <p className="text-sm text-muted-foreground">
          Manual and scheduled backups to object storage (S3/B2), encrypted, with one-click restore.
        </p>
      </header>

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
