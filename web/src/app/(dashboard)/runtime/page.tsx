"use client";

import { useEffect, useState } from "react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { apiGet, apiPost } from "@/lib/api";

interface Runtime {
  site_id: string;
  site: string;
  runtime: string;
  version: string;
  available: string[];
}

type RowState = "idle" | "switching" | "done" | "error";

export default function RuntimePage() {
  const [runtimes, setRuntimes] = useState<Runtime[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [state, setState] = useState<Record<string, RowState>>({});

  async function load() {
    try {
      const r = await apiGet<{ runtimes: Runtime[] }>("/api/v1/runtimes");
      setRuntimes(r.runtimes ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function switchVersion(row: Runtime, version: string) {
    setState((s) => ({ ...s, [row.site_id]: "switching" }));
    setError(null);
    try {
      await apiPost(`/api/v1/sites/${row.site_id}/runtime`, {
        runtime: row.runtime,
        version,
      });
      setState((s) => ({ ...s, [row.site_id]: "done" }));
      await load();
    } catch (e) {
      setState((s) => ({ ...s, [row.site_id]: "error" }));
      setError(e instanceof Error ? e.message : "Failed to switch runtime");
    }
  }

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">Runtime</h1>
        <p className="text-sm text-muted-foreground">
          Per-site runtime and language version (PHP, Node…). Changing it redeploys the container.
        </p>
      </header>

      {error && <p className="text-sm text-red-400">{error}</p>}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Sites ({runtimes.length})</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <table className="w-full text-sm">
            <thead className="border-b border-border text-left text-muted-foreground">
              <tr>
                <th className="px-6 py-3 font-medium">Site</th>
                <th className="px-6 py-3 font-medium">Runtime</th>
                <th className="px-6 py-3 font-medium">Version</th>
                <th className="px-6 py-3 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {runtimes.map((r) => {
                const st = state[r.site_id] ?? "idle";
                return (
                  <tr key={r.site_id} className="border-b border-border/60 last:border-0">
                    <td className="px-6 py-3 font-medium">{r.site}</td>
                    <td className="px-6 py-3 text-muted-foreground">{r.runtime}</td>
                    <td className="px-6 py-3">
                      {r.available.length === 0 ? (
                        <span className="text-muted-foreground">—</span>
                      ) : (
                        <select
                          value={r.version}
                          disabled={st === "switching"}
                          onChange={(e) => switchVersion(r, e.target.value)}
                          className="h-8 rounded-md border border-border bg-transparent px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-50"
                        >
                          {/* allow the current version even if outside the catalog */}
                          {!r.available.includes(r.version) && r.version && (
                            <option value={r.version} className="bg-card">
                              {r.runtime} {r.version}
                            </option>
                          )}
                          {r.available.map((v) => (
                            <option key={v} value={v} className="bg-card">
                              {r.runtime} {v}
                            </option>
                          ))}
                        </select>
                      )}
                    </td>
                    <td className="px-6 py-3 text-sm">
                      {st === "switching" && <span className="text-amber-400">redeploying…</span>}
                      {st === "done" && <span className="text-emerald-400">✓ redeployed</span>}
                      {st === "error" && <span className="text-red-400">failed</span>}
                      {st === "idle" && <span className="text-muted-foreground">—</span>}
                    </td>
                  </tr>
                );
              })}
              {runtimes.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-6 py-8 text-center text-muted-foreground">
                    No sites yet.
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
