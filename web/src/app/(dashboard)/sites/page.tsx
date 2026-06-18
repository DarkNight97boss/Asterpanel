"use client";

import { useEffect, useState, type FormEvent } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { StatusBadge } from "@/components/ui/badge";
import { createWebsite, listNodes, listWebsites, type ServerNode, type Website } from "@/lib/api";

const RUNTIMES = ["static", "node", "php", "docker", "proxy"];

export default function SitesPage() {
  const [sites, setSites] = useState<Website[]>([]);
  const [nodes, setNodes] = useState<ServerNode[]>([]);
  const [name, setName] = useState("");
  const [domain, setDomain] = useState("");
  const [runtime, setRuntime] = useState("static");
  const [nodeId, setNodeId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function refresh() {
    try {
      const [s, n] = await Promise.all([listWebsites(), listNodes()]);
      setSites(s);
      setNodes(n);
      if (!nodeId && n.length) setNodeId(n[0].id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    }
  }

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await createWebsite({ name, domain, runtime, node_id: nodeId });
      setNotice(
        res.job.dispatched
          ? `Signed job ${res.job.id.slice(0, 8)}… dispatched to the agent.`
          : `Website created; job ${res.job.id.slice(0, 8)}… queued (agent offline).`,
      );
      setName("");
      setDomain("");
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
        <h1 className="text-2xl font-semibold">Websites</h1>
        <p className="text-sm text-muted-foreground">
          Creating a site signs an Ed25519 job and dispatches it to the target node over mTLS.
        </p>
      </header>

      {error && <p className="text-sm text-red-600">{error}</p>}
      {notice && <p className="text-sm text-emerald-600">{notice}</p>}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">New website</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={onCreate} className="grid gap-4 sm:grid-cols-5 sm:items-end">
            <div className="space-y-1.5">
              <Label htmlFor="wname">Name</Label>
              <Input id="wname" value={name} onChange={(e) => setName(e.target.value)} required />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="domain">Domain</Label>
              <Input
                id="domain"
                value={domain}
                onChange={(e) => setDomain(e.target.value)}
                placeholder="example.com"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="runtime">Runtime</Label>
              <select
                id="runtime"
                value={runtime}
                onChange={(e) => setRuntime(e.target.value)}
                className="flex h-9 w-full rounded-md border border-border bg-transparent px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              >
                {RUNTIMES.map((r) => (
                  <option key={r} value={r} className="bg-card">
                    {r}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="node">Node</Label>
              <select
                id="node"
                value={nodeId}
                onChange={(e) => setNodeId(e.target.value)}
                className="flex h-9 w-full rounded-md border border-border bg-transparent px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                required
              >
                {nodes.length === 0 && <option value="">No nodes — add one first</option>}
                {nodes.map((n) => (
                  <option key={n.id} value={n.id} className="bg-card">
                    {n.name}
                  </option>
                ))}
              </select>
            </div>
            <Button type="submit" disabled={busy || nodes.length === 0}>
              {busy ? "Creating…" : "Create"}
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Websites ({sites.length})</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <table className="w-full text-sm">
            <thead className="border-b border-border text-left text-muted-foreground">
              <tr>
                <th className="px-6 py-3 font-medium">Name</th>
                <th className="px-6 py-3 font-medium">Runtime</th>
                <th className="px-6 py-3 font-medium">Status</th>
                <th className="px-6 py-3 font-medium">SSL</th>
              </tr>
            </thead>
            <tbody>
              {sites.map((s) => (
                <tr key={s.id} className="border-b border-border/60 last:border-0">
                  <td className="px-6 py-3">{s.name}</td>
                  <td className="px-6 py-3 text-muted-foreground">{s.runtime}</td>
                  <td className="px-6 py-3">
                    <StatusBadge status={s.status} />
                  </td>
                  <td className="px-6 py-3 text-muted-foreground">{s.ssl_status}</td>
                </tr>
              ))}
              {sites.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-6 py-8 text-center text-muted-foreground">
                    No websites yet.
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
