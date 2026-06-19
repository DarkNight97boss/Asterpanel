"use client";

import { useEffect, useState, type FormEvent } from "react";
import { Copy, FlaskConical, GitBranch, Rocket, Trash2 } from "lucide-react";

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

interface GitRepo {
  id: string;
  website_id: string;
  branch: string;
  clone_url: string;
  created_at: string;
}

interface StagingEnv {
  id: string;
  website_id: string;
  status: string;
  last_synced_at: string | null;
  created_at: string;
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
  const [gitSiteId, setGitSiteId] = useState("");
  const [gitRepo, setGitRepo] = useState<GitRepo | null>(null);
  const [gitBranch, setGitBranch] = useState("main");
  const [gitBusy, setGitBusy] = useState(false);
  const [stagingSiteId, setStagingSiteId] = useState("");
  const [staging, setStaging] = useState<StagingEnv | null>(null);
  const [stagingBusy, setStagingBusy] = useState(false);

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

  useEffect(() => {
    if (!gitSiteId && runtimes.length) setGitSiteId(runtimes[0].site_id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runtimes]);

  useEffect(() => {
    loadGit(gitSiteId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gitSiteId]);

  useEffect(() => {
    if (!stagingSiteId && runtimes.length) setStagingSiteId(runtimes[0].site_id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runtimes]);

  useEffect(() => {
    loadStaging(stagingSiteId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stagingSiteId]);

  async function loadGit(siteId: string) {
    if (!siteId) return;
    try {
      const { repo } = await apiGet<{ repo: GitRepo | null }>(`/api/v1/sites/${siteId}/git-repo`);
      setGitRepo(repo);
      if (repo) setGitBranch(repo.branch);
    } catch {
      setGitRepo(null);
    }
  }

  async function enableGit(e: FormEvent) {
    e.preventDefault();
    setGitBusy(true);
    setError(null);
    try {
      const { repo } = await apiPost<{ repo: GitRepo }>(`/api/v1/sites/${gitSiteId}/git-repo`, {
        branch: gitBranch.trim() || "main",
      });
      setGitRepo(repo);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not enable git deploy");
    } finally {
      setGitBusy(false);
    }
  }

  async function disableGit() {
    setError(null);
    try {
      await apiDelete(`/api/v1/sites/${gitSiteId}/git-repo`);
      setGitRepo(null);
      setGitBranch("main");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not disable git deploy");
    }
  }

  async function loadStaging(siteId: string) {
    if (!siteId) return;
    try {
      const { staging } = await apiGet<{ staging: StagingEnv | null }>(
        `/api/v1/sites/${siteId}/staging`,
      );
      setStaging(staging);
    } catch {
      setStaging(null);
    }
  }

  async function createStaging() {
    setStagingBusy(true);
    setError(null);
    try {
      const { staging } = await apiPost<{ staging: StagingEnv }>(
        `/api/v1/sites/${stagingSiteId}/staging`,
        {},
      );
      setStaging(staging);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not create staging environment");
    } finally {
      setStagingBusy(false);
    }
  }

  async function promoteStaging() {
    setStagingBusy(true);
    setError(null);
    try {
      const { staging } = await apiPost<{ staging: StagingEnv }>(
        `/api/v1/sites/${stagingSiteId}/staging/promote`,
        {},
      );
      setStaging(staging);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not promote staging environment");
    } finally {
      setStagingBusy(false);
    }
  }

  async function destroyStaging() {
    setError(null);
    try {
      await apiDelete(`/api/v1/sites/${stagingSiteId}/staging`);
      setStaging(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not delete staging environment");
    }
  }

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

      {error && <p className="text-sm text-red-600">{error}</p>}

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
                      {st === "switching" && <span className="text-amber-600">redeploying…</span>}
                      {st === "done" && <span className="text-emerald-600">✓ redeployed</span>}
                      {st === "error" && <span className="text-red-600">failed</span>}
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
          <CardTitle className="text-base">Git push-to-deploy</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Provision a bare git repo on the node. Add it as a remote and push — a post-receive hook
            checks the branch out into the site&apos;s document root.
          </p>
          {runtimes.length === 0 ? (
            <p className="text-sm text-muted-foreground">No sites.</p>
          ) : (
            <>
              <div className="flex items-center gap-3">
                <label htmlFor="git-site" className="text-sm text-muted-foreground">
                  Site
                </label>
                <select
                  id="git-site"
                  className="h-9 max-w-xs rounded-md border border-border bg-transparent px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                  value={gitSiteId}
                  onChange={(e) => setGitSiteId(e.target.value)}
                >
                  {runtimes.map((r) => (
                    <option key={r.site_id} value={r.site_id} className="bg-card">
                      {r.site}
                    </option>
                  ))}
                </select>
              </div>

              {gitRepo ? (
                <div className="space-y-3 rounded-md border border-border/60 p-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <GitBranch className="h-4 w-4 text-muted-foreground" />
                    <span className="text-sm">
                      Deploy branch <span className="font-mono font-medium">{gitRepo.branch}</span>
                    </span>
                    <Button variant="ghost" size="sm" className="ml-auto" onClick={disableGit}>
                      <Trash2 className="h-4 w-4" />
                      Disable
                    </Button>
                  </div>
                  <div className="space-y-1.5">
                    <Label>Git remote</Label>
                    <div className="flex items-center gap-2">
                      <code className="flex-1 truncate rounded-md bg-muted px-3 py-2 font-mono text-xs">
                        {gitRepo.clone_url}
                      </code>
                      <Button
                        variant="outline"
                        size="icon"
                        onClick={() => navigator.clipboard?.writeText(gitRepo.clone_url)}
                        aria-label="Copy remote URL"
                      >
                        <Copy className="h-4 w-4" />
                      </Button>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      <code className="rounded bg-muted px-1">git remote add asterpanel {gitRepo.clone_url}</code>{" "}
                      then <code className="rounded bg-muted px-1">git push asterpanel {gitRepo.branch}</code>
                    </p>
                  </div>
                </div>
              ) : (
                <form onSubmit={enableGit} className="flex items-end gap-3">
                  <div className="space-y-1.5">
                    <Label htmlFor="git-branch">Deploy branch</Label>
                    <Input
                      id="git-branch"
                      value={gitBranch}
                      onChange={(e) => setGitBranch(e.target.value)}
                      className="font-mono"
                    />
                  </div>
                  <Button type="submit" disabled={gitBusy}>
                    {gitBusy ? "Enabling…" : "Enable Git deploy"}
                  </Button>
                </form>
              )}
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Staging environment</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Clone a site&apos;s files into an isolated staging copy, test your changes, then promote
            staging back over production. The current production tree is snapshotted first, so a
            promote can be rolled back.
          </p>
          {runtimes.length === 0 ? (
            <p className="text-sm text-muted-foreground">No sites.</p>
          ) : (
            <>
              <div className="flex items-center gap-3">
                <label htmlFor="staging-site" className="text-sm text-muted-foreground">
                  Site
                </label>
                <select
                  id="staging-site"
                  className="h-9 max-w-xs rounded-md border border-border bg-transparent px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                  value={stagingSiteId}
                  onChange={(e) => setStagingSiteId(e.target.value)}
                >
                  {runtimes.map((r) => (
                    <option key={r.site_id} value={r.site_id} className="bg-card">
                      {r.site}
                    </option>
                  ))}
                </select>
              </div>

              {staging ? (
                <div className="space-y-3 rounded-md border border-border/60 p-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <FlaskConical className="h-4 w-4 text-muted-foreground" />
                    <span className="text-sm">Status</span>
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                        staging.status === "ready"
                          ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
                          : staging.status === "error"
                            ? "bg-red-500/15 text-red-600 dark:text-red-400"
                            : "bg-amber-500/15 text-amber-600 dark:text-amber-400"
                      }`}
                    >
                      {staging.status}
                    </span>
                    {staging.last_synced_at && (
                      <span className="text-xs text-muted-foreground">
                        last synced {new Date(staging.last_synced_at).toLocaleString()}
                      </span>
                    )}
                    <Button variant="ghost" size="sm" className="ml-auto" onClick={destroyStaging}>
                      <Trash2 className="h-4 w-4" />
                      Delete
                    </Button>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      onClick={promoteStaging}
                      disabled={stagingBusy || staging.status !== "ready"}
                    >
                      <Rocket className="h-4 w-4" />
                      {stagingBusy ? "Working…" : "Promote to production"}
                    </Button>
                    <Button variant="outline" onClick={createStaging} disabled={stagingBusy}>
                      <Copy className="h-4 w-4" />
                      Re-clone from production
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Staging serves a file-level copy of the document root. Database contents are not
                    cloned.
                  </p>
                </div>
              ) : (
                <Button onClick={createStaging} disabled={stagingBusy}>
                  <FlaskConical className="h-4 w-4" />
                  {stagingBusy ? "Creating…" : "Create staging environment"}
                </Button>
              )}
            </>
          )}
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
