"use client";

import { useEffect, useState, type FormEvent } from "react";
import { Plus, Rocket, Save, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { apiDelete, apiGet, apiPost, listNodes, type ServerNode } from "@/lib/api";
import { PageHeader } from "@/components/page-header";

interface Application {
  id: string;
  name: string;
  runtime: string;
  repo_url: string;
  repo_branch: string;
  install_command: string;
  build_command: string;
  start_command: string;
  status: string;
  website_id: string | null;
  server_node_id: string | null;
  created_at: string;
}

interface EnvVar {
  id: string;
  key: string;
  value: string;
  is_build_time: boolean;
}

const RUNTIMES = ["node", "php", "static", "docker", "python", "go", "ruby"];

export default function ApplicationsPage() {
  const [apps, setApps] = useState<Application[]>([]);
  const [nodes, setNodes] = useState<ServerNode[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // create form
  const [name, setName] = useState("");
  const [runtime, setRuntime] = useState("node");
  const [repoUrl, setRepoUrl] = useState("");
  const [branch, setBranch] = useState("main");
  const [nodeId, setNodeId] = useState("");
  const [creating, setCreating] = useState(false);

  // selection + detail
  const [selId, setSelId] = useState<string | null>(null);
  const [detail, setDetail] = useState<Application | null>(null);
  const [env, setEnv] = useState<EnvVar[]>([]);
  const [install, setInstall] = useState("");
  const [build, setBuild] = useState("");
  const [start, setStart] = useState("");
  const [savingCfg, setSavingCfg] = useState(false);
  const [deploying, setDeploying] = useState(false);

  // env form
  const [envKey, setEnvKey] = useState("");
  const [envVal, setEnvVal] = useState("");
  const [envBuild, setEnvBuild] = useState(false);
  const [envBusy, setEnvBusy] = useState(false);

  async function loadApps() {
    try {
      const r = await apiGet<{ applications: Application[] }>("/api/v1/applications");
      setApps(r.applications ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load applications");
    }
  }

  useEffect(() => {
    loadApps();
    listNodes()
      .then(setNodes)
      .catch(() => setNodes([]));
  }, []);

  async function loadDetail(id: string) {
    setSelId(id);
    setNotice(null);
    try {
      const r = await apiGet<{ application: Application; env: EnvVar[] }>(
        `/api/v1/applications/${id}`,
      );
      setDetail(r.application);
      setEnv(r.env ?? []);
      setInstall(r.application.install_command ?? "");
      setBuild(r.application.build_command ?? "");
      setStart(r.application.start_command ?? "");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load application");
    }
  }

  async function createApp(e: FormEvent) {
    e.preventDefault();
    setCreating(true);
    setError(null);
    try {
      const r = await apiPost<{ application: Application }>("/api/v1/applications", {
        name: name.trim(),
        runtime,
        repo_url: repoUrl.trim(),
        branch: branch.trim(),
        node_id: nodeId,
      });
      setName("");
      setRepoUrl("");
      await loadApps();
      await loadDetail(r.application.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not create application");
    } finally {
      setCreating(false);
    }
  }

  async function saveConfig() {
    if (!selId) return;
    setSavingCfg(true);
    setError(null);
    setNotice(null);
    try {
      await apiPost(`/api/v1/applications/${selId}/config`, {
        install_command: install,
        build_command: build,
        start_command: start,
      });
      setNotice("Configuration saved. Deploy to apply it to the running container.");
      await loadApps();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save configuration");
    } finally {
      setSavingCfg(false);
    }
  }

  async function addEnv(e: FormEvent) {
    e.preventDefault();
    if (!selId) return;
    setEnvBusy(true);
    setError(null);
    try {
      await apiPost(`/api/v1/applications/${selId}/env`, {
        key: envKey.trim(),
        value: envVal,
        is_build_time: envBuild,
      });
      setEnvKey("");
      setEnvVal("");
      setEnvBuild(false);
      await loadDetail(selId);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not set env var");
    } finally {
      setEnvBusy(false);
    }
  }

  async function delEnv(id: string) {
    if (!selId) return;
    try {
      await apiDelete(`/api/v1/applications/${selId}/env/${id}`);
      await loadDetail(selId);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not delete env var");
    }
  }

  async function deploy() {
    if (!selId || !detail) return;
    setDeploying(true);
    setError(null);
    setNotice(null);
    try {
      await apiPost(`/api/v1/applications/${selId}/deployments`, {
        node_id: detail.server_node_id,
        ref: detail.repo_branch || "main",
        git_url: detail.repo_url,
      });
      setNotice("Deployment queued — env vars and start command will be applied.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not start deployment");
    } finally {
      setDeploying(false);
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Applications"
        description="Git-deployed apps: edit the install / build / start commands and per-app environment variables. They are applied on the next deploy."
      />

      {error && <p className="text-sm text-red-600">{error}</p>}
      {notice && <p className="text-sm text-emerald-600">{notice}</p>}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">New application</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={createApp} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 sm:items-end">
            <div className="space-y-1.5">
              <Label htmlFor="app-name">Name</Label>
              <Input id="app-name" value={name} onChange={(e) => setName(e.target.value)} required />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="app-runtime">Runtime</Label>
              <select
                id="app-runtime"
                className="flex h-9 w-full rounded-md border border-border bg-transparent px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                value={runtime}
                onChange={(e) => setRuntime(e.target.value)}
              >
                {RUNTIMES.map((r) => (
                  <option key={r} value={r} className="bg-card">
                    {r}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="app-node">Node</Label>
              <select
                id="app-node"
                className="flex h-9 w-full rounded-md border border-border bg-transparent px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                value={nodeId}
                onChange={(e) => setNodeId(e.target.value)}
              >
                <option value="" className="bg-card">
                  — none —
                </option>
                {nodes.map((n) => (
                  <option key={n.id} value={n.id} className="bg-card">
                    {n.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="app-repo">Repository URL</Label>
              <Input
                id="app-repo"
                value={repoUrl}
                onChange={(e) => setRepoUrl(e.target.value)}
                placeholder="https://github.com/acme/api.git"
                className="font-mono"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="app-branch">Branch</Label>
              <Input
                id="app-branch"
                value={branch}
                onChange={(e) => setBranch(e.target.value)}
                className="font-mono"
              />
            </div>
            <Button type="submit" disabled={creating}>
              <Plus className="h-4 w-4" />
              {creating ? "Creating…" : "Create application"}
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Applications ({apps.length})</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <table className="w-full text-sm">
            <thead className="border-b border-border text-left text-muted-foreground">
              <tr>
                <th className="px-6 py-3 font-medium">Name</th>
                <th className="px-6 py-3 font-medium">Runtime</th>
                <th className="px-6 py-3 font-medium">Start command</th>
                <th className="px-6 py-3 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {apps.map((a) => (
                <tr
                  key={a.id}
                  onClick={() => loadDetail(a.id)}
                  className={`cursor-pointer border-b border-border/60 last:border-0 hover:bg-muted/50 ${
                    selId === a.id ? "bg-muted/60" : ""
                  }`}
                >
                  <td className="px-6 py-3 font-medium">{a.name}</td>
                  <td className="px-6 py-3 text-muted-foreground">{a.runtime}</td>
                  <td className="px-6 py-3 font-mono text-xs text-muted-foreground">
                    {a.start_command || "—"}
                  </td>
                  <td className="px-6 py-3 text-muted-foreground">{a.status}</td>
                </tr>
              ))}
              {apps.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-6 py-8 text-center text-muted-foreground">
                    No applications yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </CardContent>
      </Card>

      {detail && (
        <Card>
          <CardHeader className="flex-row items-center justify-between space-y-0">
            <CardTitle className="text-base">
              Configure <span className="font-mono">{detail.name}</span>
            </CardTitle>
            <Button
              onClick={deploy}
              disabled={deploying || !detail.server_node_id}
              title={detail.server_node_id ? "" : "Assign a node to deploy"}
            >
              <Rocket className="h-4 w-4" />
              {deploying ? "Queuing…" : "Deploy"}
            </Button>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="cmd-install">Install command</Label>
                <Input
                  id="cmd-install"
                  value={install}
                  onChange={(e) => setInstall(e.target.value)}
                  placeholder="npm ci"
                  className="font-mono"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="cmd-build">Build command</Label>
                <Input
                  id="cmd-build"
                  value={build}
                  onChange={(e) => setBuild(e.target.value)}
                  placeholder="npm run build"
                  className="font-mono"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="cmd-start">Start command</Label>
                <Input
                  id="cmd-start"
                  value={start}
                  onChange={(e) => setStart(e.target.value)}
                  placeholder="npm run start"
                  className="font-mono"
                />
                <p className="text-xs text-muted-foreground">
                  Runs as <code className="rounded bg-muted px-1">sh -c</code> inside the container,
                  overriding the image&apos;s default command.
                </p>
              </div>
              <Button onClick={saveConfig} disabled={savingCfg} variant="outline">
                <Save className="h-4 w-4" />
                {savingCfg ? "Saving…" : "Save commands"}
              </Button>
            </div>

            <div className="space-y-3">
              <h3 className="text-sm font-medium">Environment variables</h3>
              {env.length > 0 && (
                <ul className="divide-y divide-border/60 rounded-md border border-border/60">
                  {env.map((v) => (
                    <li key={v.id} className="flex items-center gap-3 px-4 py-2 text-sm">
                      <span className="font-mono">{v.key}</span>
                      <span className="text-muted-foreground">=</span>
                      <span className="truncate font-mono text-muted-foreground">{v.value}</span>
                      <span className="ml-auto rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                        {v.is_build_time ? "build" : "runtime"}
                      </span>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7"
                        onClick={() => delEnv(v.id)}
                        aria-label="Delete env var"
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
              <form onSubmit={addEnv} className="grid gap-3 sm:grid-cols-[1fr_1fr_auto_auto] sm:items-end">
                <div className="space-y-1.5">
                  <Label htmlFor="env-key">Key</Label>
                  <Input
                    id="env-key"
                    value={envKey}
                    onChange={(e) => setEnvKey(e.target.value)}
                    placeholder="DATABASE_URL"
                    className="font-mono"
                    required
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="env-val">Value</Label>
                  <Input
                    id="env-val"
                    value={envVal}
                    onChange={(e) => setEnvVal(e.target.value)}
                    className="font-mono"
                  />
                </div>
                <label className="flex h-9 items-center gap-2 text-sm text-muted-foreground">
                  <input
                    type="checkbox"
                    checked={envBuild}
                    onChange={(e) => setEnvBuild(e.target.checked)}
                  />
                  build-time
                </label>
                <Button type="submit" disabled={envBusy}>
                  <Plus className="h-4 w-4" />
                  {envBusy ? "Adding…" : "Add"}
                </Button>
              </form>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
