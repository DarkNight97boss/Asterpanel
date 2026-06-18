"use client";

import { useEffect, useState, type FormEvent } from "react";
import { Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { apiDelete, apiGet, apiPost } from "@/lib/api";
import { PageHeader } from "@/components/page-header";

interface Runtime {
  site_id: string;
  site: string;
  runtime: string;
  version: string;
  available: string[];
}

interface PhpSetting {
  id: string;
  directive: string;
  value: string;
}

type RowState = "idle" | "switching" | "done" | "error";

export default function RuntimePage() {
  const [runtimes, setRuntimes] = useState<Runtime[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [state, setState] = useState<Record<string, RowState>>({});
  const [phpSiteId, setPhpSiteId] = useState("");
  const [phpSettings, setPhpSettings] = useState<PhpSetting[]>([]);
  const [phpAllowed, setPhpAllowed] = useState<string[]>([]);
  const [phpDir, setPhpDir] = useState("memory_limit");
  const [phpVal, setPhpVal] = useState("");
  const [phpBusy, setPhpBusy] = useState(false);

  const phpSites = runtimes.filter((r) => r.runtime === "php");

  async function loadPhp(siteId: string) {
    if (!siteId) return;
    try {
      const r = await apiGet<{ settings: PhpSetting[]; allowed: string[] }>(
        `/api/v1/sites/${siteId}/php-settings`,
      );
      setPhpSettings(r.settings ?? []);
      setPhpAllowed((r.allowed ?? []).slice().sort());
    } catch {
      setPhpSettings([]);
    }
  }

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

  useEffect(() => {
    if (!phpSiteId && phpSites.length) setPhpSiteId(phpSites[0].site_id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runtimes]);

  useEffect(() => {
    loadPhp(phpSiteId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phpSiteId]);

  async function onAddPhp(e: FormEvent) {
    e.preventDefault();
    setPhpBusy(true);
    setError(null);
    try {
      await apiPost(`/api/v1/sites/${phpSiteId}/php-settings`, {
        directive: phpDir,
        value: phpVal.trim(),
      });
      setPhpVal("");
      await loadPhp(phpSiteId);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save php.ini directive");
    } finally {
      setPhpBusy(false);
    }
  }

  async function onDeletePhp(id: string) {
    try {
      await apiDelete(`/api/v1/sites/${phpSiteId}/php-settings/${id}`);
      await loadPhp(phpSiteId);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not delete directive");
    }
  }

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
      <PageHeader
        title="Runtime"
        description="Per-site runtime and language version (PHP, Node…). Changing it redeploys the container."
      />

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

      <Card>
        <CardHeader>
          <CardTitle className="text-base">php.ini overrides (MultiPHP INI)</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Per-site PHP directives, rendered into the container&apos;s <code>conf.d</code>. Only a
            safe allowlist of directives can be set.
          </p>
          {phpSites.length === 0 ? (
            <p className="text-sm text-muted-foreground">No PHP sites.</p>
          ) : (
            <>
              <div className="flex items-center gap-3">
                <label htmlFor="php-site" className="text-sm text-muted-foreground">
                  Site
                </label>
                <select
                  id="php-site"
                  className="h-9 max-w-xs rounded-md border border-border bg-transparent px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                  value={phpSiteId}
                  onChange={(e) => setPhpSiteId(e.target.value)}
                >
                  {phpSites.map((r) => (
                    <option key={r.site_id} value={r.site_id} className="bg-card">
                      {r.site}
                    </option>
                  ))}
                </select>
              </div>

              <form onSubmit={onAddPhp} className="grid gap-3 sm:grid-cols-3 sm:items-end">
                <div className="space-y-1.5">
                  <Label htmlFor="php-dir">Directive</Label>
                  <select
                    id="php-dir"
                    className="flex h-9 w-full rounded-md border border-border bg-transparent px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                    value={phpDir}
                    onChange={(e) => setPhpDir(e.target.value)}
                  >
                    {phpAllowed.map((d) => (
                      <option key={d} value={d} className="bg-card">
                        {d}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="php-val">Value</Label>
                  <Input
                    id="php-val"
                    value={phpVal}
                    onChange={(e) => setPhpVal(e.target.value)}
                    placeholder="256M"
                    required
                  />
                </div>
                <Button type="submit" disabled={phpBusy}>
                  {phpBusy ? "Saving…" : "Set directive"}
                </Button>
              </form>

              {phpSettings.length > 0 && (
                <ul className="divide-y divide-border/60 rounded-md border border-border/60">
                  {phpSettings.map((s) => (
                    <li key={s.id} className="flex items-center gap-3 px-4 py-2 text-sm">
                      <span className="font-mono">{s.directive}</span>
                      <span className="text-muted-foreground">=</span>
                      <span className="font-mono text-muted-foreground">{s.value}</span>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="ml-auto h-7 w-7"
                        onClick={() => onDeletePhp(s.id)}
                        aria-label="Delete directive"
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
