"use client";

import { useEffect, useState, type FormEvent } from "react";
import { Pencil, Trash2, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { apiDelete, apiGet, apiPost } from "@/lib/api";
import { PageHeader } from "@/components/page-header";

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
  const [editId, setEditId] = useState<string | null>(null);
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

  function startEdit(r: Rule) {
    setEditId(r.id);
    setAction(r.action);
    setSource(r.source);
    setPort(r.port);
    setNote(r.note || "");
  }
  function cancelEdit() {
    setEditId(null);
    setAction("deny");
    setSource("");
    setPort("*");
    setNote("");
  }

  async function onAdd(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (editId) {
        await apiPost(`/api/v1/firewall/${editId}`, { action, source, port, note });
        setEditId(null);
      } else {
        await apiPost("/api/v1/firewall", { action, source, port, note });
      }
      setSource("");
      setNote("");
      setPort("*");
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(false);
    }
  }

  async function onDelete(id: string) {
    setError(null);
    try {
      await apiDelete(`/api/v1/firewall/${id}`);
      if (editId === id) cancelEdit();
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not delete rule");
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader title={"Firewall"} description={"Per-tenant network rules. Default-deny inbound; only the control plane reaches the agent."} />

      {error && <p className="text-sm text-red-600">{error}</p>}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{editId ? "Edit rule" : "New rule"}</CardTitle>
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
            <div className="flex items-center gap-2">
              <Button type="submit" disabled={busy}>
                {busy ? "Saving…" : editId ? "Save" : "Add"}
              </Button>
              {editId && (
                <Button type="button" variant="ghost" size="icon" onClick={cancelEdit} aria-label="Cancel">
                  <X className="h-4 w-4" />
                </Button>
              )}
            </div>
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
                <th className="px-6 py-3" />
              </tr>
            </thead>
            <tbody>
              {rules.map((r) => (
                <tr key={r.id} className={cn("border-b border-border/60 last:border-0", editId === r.id && "bg-muted/60")}>
                  <td className="px-6 py-3">
                    <span
                      className={cn(
                        "rounded-full border px-2 py-0.5 text-xs font-medium",
                        r.action === "allow"
                          ? "border-emerald-500/30 bg-emerald-500/15 text-emerald-600"
                          : "border-red-500/30 bg-red-500/15 text-red-600",
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
                        <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-xs font-medium text-amber-600">
                          auto
                        </span>
                        {r.note}
                      </span>
                    ) : (
                      r.note
                    )}
                  </td>
                  <td className="px-6 py-3 text-right">
                    <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => startEdit(r)} aria-label="Edit rule">
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => onDelete(r.id)} aria-label="Delete rule">
                      <Trash2 className="h-4 w-4" />
                    </Button>
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
