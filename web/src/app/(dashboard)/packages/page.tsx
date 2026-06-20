"use client";

import { useEffect, useState, type FormEvent } from "react";
import { Check, Plus, Save, Trash2, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { apiDelete, apiGet, apiPost } from "@/lib/api";
import { PageHeader } from "@/components/page-header";

interface Plan {
  id: string;
  code: string;
  name: string;
  description: string;
  price_cents: number;
  currency: string;
  interval: string;
  limits: Record<string, number>;
  is_active: boolean;
}

const QUOTAS: { key: string; label: string }[] = [
  { key: "max_sites", label: "Sites" },
  { key: "max_apps", label: "Apps" },
  { key: "max_domains", label: "Domains" },
  { key: "max_databases", label: "Databases" },
  { key: "max_mailboxes", label: "Mailboxes" },
  { key: "max_nodes", label: "Nodes" },
  { key: "max_accounts", label: "Sub-accounts" },
];

const emptyLimits = (): Record<string, string> =>
  Object.fromEntries(QUOTAS.map((q) => [q.key, ""]));

export default function PackagesPage() {
  const [plans, setPlans] = useState<Plan[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [editId, setEditId] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [price, setPrice] = useState("");
  const [interval, setInterval] = useState("month");
  const [limits, setLimits] = useState<Record<string, string>>(emptyLimits());
  const [busy, setBusy] = useState(false);

  async function load() {
    try {
      const r = await apiGet<{ plans: Plan[] }>("/api/v1/plans");
      setPlans(r.plans ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load plans");
    }
  }
  useEffect(() => {
    load();
  }, []);

  function resetForm() {
    setEditId(null);
    setCode("");
    setName("");
    setDescription("");
    setPrice("");
    setInterval("month");
    setLimits(emptyLimits());
  }

  function edit(p: Plan) {
    setEditId(p.id);
    setCode(p.code);
    setName(p.name);
    setDescription(p.description ?? "");
    setPrice((p.price_cents / 100).toString());
    setInterval(p.interval);
    setLimits(
      Object.fromEntries(
        QUOTAS.map((q) => [q.key, p.limits?.[q.key] != null ? String(p.limits[q.key]) : ""]),
      ),
    );
    setNotice(null);
  }

  function limitsPayload(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const q of QUOTAS) {
      const v = limits[q.key];
      if (v !== "" && Number.isFinite(Number(v))) out[q.key] = Math.max(0, Math.floor(Number(v)));
    }
    return out;
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    const priceCents = Math.max(0, Math.round((parseFloat(price) || 0) * 100));
    try {
      if (editId) {
        await apiPost(`/api/v1/plans/${editId}`, {
          name,
          description,
          price_cents: priceCents,
          limits: limitsPayload(),
        });
        setNotice(`Package “${name}” updated.`);
      } else {
        await apiPost("/api/v1/plans", {
          code,
          name,
          description,
          price_cents: priceCents,
          interval,
          limits: limitsPayload(),
        });
        setNotice(`Package “${name}” created.`);
      }
      resetForm();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save package");
    } finally {
      setBusy(false);
    }
  }

  async function toggleActive(p: Plan) {
    setError(null);
    try {
      await apiPost(`/api/v1/plans/${p.id}`, { is_active: !p.is_active });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not update package");
    }
  }

  async function del(p: Plan) {
    setError(null);
    try {
      await apiDelete(`/api/v1/plans/${p.id}`);
      if (editId === p.id) resetForm();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not delete package");
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Packages"
        description="Hosting plans and their resource quotas. Limits are enforced when an account creates sites, apps, domains, databases or mailboxes. Payment is handled separately."
      />

      {error && <p className="text-sm text-red-600">{error}</p>}
      {notice && <p className="text-sm text-emerald-600">{notice}</p>}

      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <CardTitle className="text-base">
            {editId ? `Edit package` : "New package"}
          </CardTitle>
          {editId && (
            <Button variant="ghost" size="sm" onClick={resetForm}>
              <X className="h-4 w-4" />
              Cancel edit
            </Button>
          )}
        </CardHeader>
        <CardContent>
          <form onSubmit={submit} className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <div className="space-y-1.5">
                <Label htmlFor="pkg-code">Code</Label>
                <Input
                  id="pkg-code"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  placeholder="starter"
                  className="font-mono"
                  disabled={!!editId}
                  required
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="pkg-name">Name</Label>
                <Input id="pkg-name" value={name} onChange={(e) => setName(e.target.value)} required />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="pkg-price">Price ({"€"})</Label>
                <Input
                  id="pkg-price"
                  type="number"
                  min="0"
                  step="0.01"
                  value={price}
                  onChange={(e) => setPrice(e.target.value)}
                  placeholder="0"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="pkg-interval">Interval</Label>
                <select
                  id="pkg-interval"
                  className="flex h-9 w-full rounded-md border border-border bg-transparent px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-50"
                  value={interval}
                  onChange={(e) => setInterval(e.target.value)}
                  disabled={!!editId}
                >
                  <option value="month" className="bg-card">
                    monthly
                  </option>
                  <option value="year" className="bg-card">
                    yearly
                  </option>
                </select>
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="pkg-desc">Description</Label>
              <Input
                id="pkg-desc"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="For small teams"
              />
            </div>

            <div>
              <Label className="text-muted-foreground">Quotas (blank = unlimited)</Label>
              <div className="mt-2 grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
                {QUOTAS.map((q) => (
                  <div key={q.key} className="space-y-1.5">
                    <Label htmlFor={`q-${q.key}`} className="text-xs">
                      {q.label}
                    </Label>
                    <Input
                      id={`q-${q.key}`}
                      type="number"
                      min="0"
                      value={limits[q.key]}
                      onChange={(e) => setLimits((l) => ({ ...l, [q.key]: e.target.value }))}
                      placeholder="∞"
                    />
                  </div>
                ))}
              </div>
            </div>

            <Button type="submit" disabled={busy}>
              {editId ? <Save className="h-4 w-4" /> : <Plus className="h-4 w-4" />}
              {busy ? "Saving…" : editId ? "Save package" : "Create package"}
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Packages ({plans.length})</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <table className="w-full text-sm">
            <thead className="border-b border-border text-left text-muted-foreground">
              <tr>
                <th className="px-6 py-3 font-medium">Code</th>
                <th className="px-6 py-3 font-medium">Name</th>
                <th className="px-6 py-3 font-medium">Price</th>
                <th className="px-6 py-3 font-medium">Quotas</th>
                <th className="px-6 py-3 font-medium">Active</th>
                <th className="px-6 py-3" />
              </tr>
            </thead>
            <tbody>
              {plans.map((p) => (
                <tr
                  key={p.id}
                  className={`border-b border-border/60 last:border-0 ${editId === p.id ? "bg-muted/60" : ""}`}
                >
                  <td className="px-6 py-3 font-mono text-xs">{p.code}</td>
                  <td className="px-6 py-3 font-medium">{p.name}</td>
                  <td className="px-6 py-3 text-muted-foreground">
                    {p.price_cents === 0
                      ? "free"
                      : `${(p.price_cents / 100).toFixed(2)} ${p.currency}/${p.interval === "year" ? "yr" : "mo"}`}
                  </td>
                  <td className="px-6 py-3 text-xs text-muted-foreground">
                    {QUOTAS.filter((q) => p.limits?.[q.key] != null)
                      .map((q) => `${q.label.toLowerCase()} ${p.limits[q.key]}`)
                      .join(" · ") || "unlimited"}
                  </td>
                  <td className="px-6 py-3">
                    <button
                      onClick={() => toggleActive(p)}
                      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${
                        p.is_active
                          ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
                          : "bg-muted text-muted-foreground"
                      }`}
                      title="Toggle active"
                    >
                      {p.is_active ? <Check className="h-3 w-3" /> : <X className="h-3 w-3" />}
                      {p.is_active ? "active" : "inactive"}
                    </button>
                  </td>
                  <td className="px-6 py-3 text-right">
                    <Button variant="ghost" size="sm" onClick={() => edit(p)}>
                      Edit
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7"
                      onClick={() => del(p)}
                      aria-label="Delete package"
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </td>
                </tr>
              ))}
              {plans.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-6 py-8 text-center text-muted-foreground">
                    No packages yet.
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
