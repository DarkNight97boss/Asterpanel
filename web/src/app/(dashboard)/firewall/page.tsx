"use client";

import { useEffect, useState, type FormEvent } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { apiGet, apiPost } from "@/lib/api";

interface Rule {
  id: string;
  action: string;
  source: string;
  port: string;
  note: string;
}

export default function FirewallPage() {
  const [rules, setRules] = useState<Rule[]>([]);
  const [action, setAction] = useState("deny");
  const [source, setSource] = useState("");
  const [port, setPort] = useState("*");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    try {
      const { rules } = await apiGet<{ rules: Rule[] }>("/api/v1/firewall");
      setRules(rules);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    }
  }
  useEffect(() => {
    refresh();
  }, []);

  async function onAdd(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await apiPost("/api/v1/firewall", { action, source, port, note });
      setSource("");
      setNote("");
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">Firewall</h1>
        <p className="text-sm text-muted-foreground">
          Per-tenant network rules. Default-deny inbound; only the control plane reaches the agent.
        </p>
      </header>

      {error && <p className="text-sm text-red-400">{error}</p>}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">New rule</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={onAdd} className="grid gap-4 sm:grid-cols-6 sm:items-end">
            <div className="space-y-1.5">
              <Label htmlFor="action">Action</Label>
              <select
                id="action"
                value={action}
                onChange={(e) => setAction(e.target.value)}
                className="flex h-9 w-full rounded-md border border-border bg-transparent px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              >
                <option value="allow" className="bg-card">allow</option>
                <option value="deny" className="bg-card">deny</option>
              </select>
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="source">Source (CIDR/IP)</Label>
              <Input id="source" value={source} onChange={(e) => setSource(e.target.value)} placeholder="203.0.113.0/24" required />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="port">Port</Label>
              <Input id="port" value={port} onChange={(e) => setPort(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="note">Note</Label>
              <Input id="note" value={note} onChange={(e) => setNote(e.target.value)} />
            </div>
            <Button type="submit" disabled={busy}>
              {busy ? "Adding…" : "Add"}
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Rules ({rules.length})</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <table className="w-full text-sm">
            <thead className="border-b border-border text-left text-muted-foreground">
              <tr>
                <th className="px-6 py-3 font-medium">Action</th>
                <th className="px-6 py-3 font-medium">Source</th>
                <th className="px-6 py-3 font-medium">Port</th>
                <th className="px-6 py-3 font-medium">Note</th>
              </tr>
            </thead>
            <tbody>
              {rules.map((r) => (
                <tr key={r.id} className="border-b border-border/60 last:border-0">
                  <td className="px-6 py-3">
                    <span
                      className={cn(
                        "rounded-full border px-2 py-0.5 text-xs font-medium",
                        r.action === "allow"
                          ? "border-emerald-500/30 bg-emerald-500/15 text-emerald-400"
                          : "border-red-500/30 bg-red-500/15 text-red-400",
                      )}
                    >
                      {r.action}
                    </span>
                  </td>
                  <td className="px-6 py-3 font-mono text-xs">{r.source}</td>
                  <td className="px-6 py-3 font-mono text-xs text-muted-foreground">{r.port}</td>
                  <td className="px-6 py-3 text-muted-foreground">
                    {r.note?.startsWith("auto-ban") ? (
                      <span className="inline-flex items-center gap-1.5">
                        <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-xs font-medium text-amber-400">
                          auto
                        </span>
                        {r.note}
                      </span>
                    ) : (
                      r.note
                    )}
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
