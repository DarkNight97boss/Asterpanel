"use client";

import { useEffect, useState, type FormEvent } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { StatusBadge } from "@/components/ui/badge";
import { createEnrollment, createNode, listNodes, type ServerNode } from "@/lib/api";
import { PageHeader } from "@/components/page-header";

export default function NodesPage() {
  const [nodes, setNodes] = useState<ServerNode[]>([]);
  const [name, setName] = useState("");
  const [hostname, setHostname] = useState("");
  const [region, setRegion] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [enrollment, setEnrollment] = useState<{ token: string; expiresAt: string } | null>(null);

  async function refresh() {
    try {
      setNodes(await listNodes());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load nodes");
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
      await createNode({ name, hostname, region: region || undefined });
      setName("");
      setHostname("");
      setRegion("");
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Create failed");
    } finally {
      setBusy(false);
    }
  }

  async function onEnroll(id: string) {
    setError(null);
    try {
      const r = await createEnrollment(id);
      setEnrollment({ token: r.enrollment_token, expiresAt: r.expires_at });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Enrollment failed");
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Server nodes"
        description="Register hosting nodes and issue one-time agent enrollment tokens."
      />

      {error && <p className="text-sm text-red-400">{error}</p>}

      {enrollment && (
        <Card className="border-primary/40">
          <CardHeader>
            <CardTitle className="text-base">One-time enrollment token</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <p className="text-sm text-muted-foreground">
              Run the agent installer with this token. It is shown once and expires{" "}
              {new Date(enrollment.expiresAt).toLocaleTimeString()}.
            </p>
            <pre className="overflow-x-auto rounded-md bg-muted p-3 text-xs">
              AGENT_ENROLLMENT_TOKEN={enrollment.token}
            </pre>
            <Button variant="outline" size="sm" onClick={() => setEnrollment(null)}>
              Dismiss
            </Button>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Register a node</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={onCreate} className="grid gap-4 sm:grid-cols-4 sm:items-end">
            <div className="space-y-1.5">
              <Label htmlFor="name">Name</Label>
              <Input id="name" value={name} onChange={(e) => setName(e.target.value)} required />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="hostname">Hostname</Label>
              <Input
                id="hostname"
                value={hostname}
                onChange={(e) => setHostname(e.target.value)}
                placeholder="node1.example.com"
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="region">Region</Label>
              <Input id="region" value={region} onChange={(e) => setRegion(e.target.value)} placeholder="eu-west" />
            </div>
            <Button type="submit" disabled={busy}>
              {busy ? "Adding…" : "Add node"}
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Nodes ({nodes.length})</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <table className="w-full text-sm">
            <thead className="border-b border-border text-left text-muted-foreground">
              <tr>
                <th className="px-6 py-3 font-medium">Name</th>
                <th className="px-6 py-3 font-medium">Hostname</th>
                <th className="px-6 py-3 font-medium">Status</th>
                <th className="px-6 py-3 font-medium">Agent</th>
                <th className="px-6 py-3" />
              </tr>
            </thead>
            <tbody>
              {nodes.map((n) => (
                <tr key={n.id} className="border-b border-border/60 last:border-0">
                  <td className="px-6 py-3">{n.name}</td>
                  <td className="px-6 py-3 text-muted-foreground">{n.hostname}</td>
                  <td className="px-6 py-3">
                    <StatusBadge status={n.status} />
                  </td>
                  <td className="px-6 py-3 text-muted-foreground">{n.agent_version ?? "—"}</td>
                  <td className="px-6 py-3 text-right">
                    <Button variant="outline" size="sm" onClick={() => onEnroll(n.id)}>
                      Enroll
                    </Button>
                  </td>
                </tr>
              ))}
              {nodes.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-6 py-8 text-center text-muted-foreground">
                    No nodes yet — register one above.
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
