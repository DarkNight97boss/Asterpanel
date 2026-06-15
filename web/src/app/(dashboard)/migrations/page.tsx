"use client";

import { useEffect, useState } from "react";
import { X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { apiGet, apiPost } from "@/lib/api";

interface PlanDomain {
  fqdn: string;
  records: { name: string; type: string; content: string }[];
}
interface Plan {
  account: string;
  domains: PlanDomain[];
  databases: string[];
  mailboxes: string[];
}
interface LogEntry {
  resource: string;
  item: string;
  result: string;
  detail?: string;
  records?: number;
}
interface Migration {
  id: string;
  source_type: string;
  source_label: string | null;
  status: "planned" | "importing" | "completed" | "failed";
  domains_count: number;
  databases_count: number;
  mailboxes_count: number;
  created_at: string;
  plan?: Plan;
  log?: LogEntry[];
}

const SAMPLE = JSON.stringify(
  {
    account: "acmeuser",
    domains: [
      {
        domain: "acme.com",
        dns: [
          { name: "@", type: "A", content: "203.0.113.10", ttl: 3600 },
          { name: "www", type: "CNAME", content: "acme.com.", ttl: 3600 },
          { name: "@", type: "MX", content: "mail.acme.com.", ttl: 3600, priority: 10 },
          { name: "@", type: "TXT", content: "v=spf1 mx ~all", ttl: 3600 },
        ],
      },
      { domain: "shop.acme.com", dns: [{ name: "@", type: "A", content: "203.0.113.11", ttl: 3600 }] },
    ],
    databases: ["acme_wp", "acme_shop"],
    mailboxes: ["info@acme.com", "sales@acme.com"],
  },
  null,
  2,
);

const statusBadge: Record<Migration["status"], string> = {
  planned: "bg-amber-500/15 text-amber-400",
  importing: "bg-primary/15 text-primary",
  completed: "bg-emerald-500/15 text-emerald-400",
  failed: "bg-red-500/15 text-red-400",
};

export default function MigrationsPage() {
  const [migrations, setMigrations] = useState<Migration[]>([]);
  const [sourceType, setSourceType] = useState("cpanel");
  const [label, setLabel] = useState("");
  const [manifest, setManifest] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<Migration | null>(null);

  async function load() {
    try {
      const { migrations } = await apiGet<{ migrations: Migration[] }>("/api/v1/migrations");
      setMigrations(migrations ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    }
  }
  useEffect(() => {
    load();
  }, []);

  async function analyze() {
    setBusy(true);
    setError(null);
    let parsed: unknown;
    try {
      parsed = JSON.parse(manifest);
    } catch {
      setError("Manifest is not valid JSON.");
      setBusy(false);
      return;
    }
    try {
      const { migration } = await apiPost<{ migration: Migration }>("/api/v1/migrations", {
        source_type: sourceType,
        source_label: label,
        manifest: parsed,
      });
      setDetail(migration);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Analyze failed");
    } finally {
      setBusy(false);
    }
  }

  async function runImport(id: string) {
    setBusy(true);
    setError(null);
    try {
      const { migration } = await apiPost<{ migration: Migration }>(`/api/v1/migrations/${id}/import`);
      setDetail(migration);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Import failed");
    } finally {
      setBusy(false);
    }
  }

  async function open(id: string) {
    try {
      const { migration } = await apiGet<{ migration: Migration }>(`/api/v1/migrations/${id}`);
      setDetail(migration);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to open");
    }
  }

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">Migrations</h1>
        <p className="text-sm text-muted-foreground">
          Import accounts from cPanel/Plesk. Paste a normalized account manifest, review the plan,
          then run the import.
        </p>
      </header>

      {error && <p className="text-sm text-red-400">{error}</p>}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">New migration</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1">
              <Label htmlFor="src">Source</Label>
              <select
                id="src"
                value={sourceType}
                onChange={(e) => setSourceType(e.target.value)}
                className="h-9 rounded-md border border-input bg-background px-3 text-sm"
              >
                <option value="cpanel">cPanel</option>
                <option value="plesk">Plesk</option>
              </select>
            </div>
            <div className="grow space-y-1">
              <Label htmlFor="label">Label</Label>
              <Input
                id="label"
                placeholder="e.g. old-host acmeuser"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
              />
            </div>
            <Button variant="outline" size="sm" onClick={() => setManifest(SAMPLE)}>
              Load sample
            </Button>
          </div>
          <textarea
            value={manifest}
            onChange={(e) => setManifest(e.target.value)}
            spellCheck={false}
            placeholder="Paste the account manifest JSON…"
            className="h-48 w-full resize-none rounded-md border border-input bg-background p-3 font-mono text-xs outline-none"
          />
          <Button disabled={busy || !manifest.trim()} onClick={analyze}>
            Analyze
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Migrations ({migrations.length})</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <table className="w-full text-sm">
            <thead className="border-b border-border text-left text-muted-foreground">
              <tr>
                <th className="px-6 py-3 font-medium">Source</th>
                <th className="px-6 py-3 font-medium">Domains</th>
                <th className="px-6 py-3 font-medium">DBs</th>
                <th className="px-6 py-3 font-medium">Mailboxes</th>
                <th className="px-6 py-3 font-medium">Status</th>
                <th className="px-6 py-3" />
              </tr>
            </thead>
            <tbody>
              {migrations.map((m) => (
                <tr key={m.id} className="border-b border-border/60 last:border-0">
                  <td className="px-6 py-3">
                    {m.source_label || m.source_type}
                    <span className="ml-1 text-xs text-muted-foreground">({m.source_type})</span>
                  </td>
                  <td className="px-6 py-3 text-muted-foreground">{m.domains_count}</td>
                  <td className="px-6 py-3 text-muted-foreground">{m.databases_count}</td>
                  <td className="px-6 py-3 text-muted-foreground">{m.mailboxes_count}</td>
                  <td className="px-6 py-3">
                    <span
                      className={cn(
                        "rounded-full px-2 py-0.5 text-xs font-medium capitalize",
                        statusBadge[m.status],
                      )}
                    >
                      {m.status}
                    </span>
                  </td>
                  <td className="px-6 py-3 text-right">
                    <Button variant="ghost" size="sm" onClick={() => open(m.id)}>
                      View
                    </Button>
                    {m.status === "planned" && (
                      <Button size="sm" disabled={busy} onClick={() => runImport(m.id)}>
                        Import
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
              {migrations.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-6 py-8 text-center text-muted-foreground">
                    No migrations yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </CardContent>
      </Card>

      {detail && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          onClick={() => setDetail(null)}
        >
          <div
            className="flex max-h-[85vh] w-full max-w-2xl flex-col overflow-hidden rounded-lg border border-border bg-background shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-border px-5 py-3">
              <span className="font-medium capitalize">
                {detail.source_label || detail.source_type} — {detail.status}
              </span>
              <Button variant="ghost" size="icon" onClick={() => setDetail(null)}>
                <X className="h-4 w-4" />
              </Button>
            </div>
            <div className="space-y-4 overflow-auto p-5 text-sm">
              {detail.plan && (
                <div>
                  <p className="mb-1 font-medium">Plan</p>
                  <ul className="space-y-1 text-muted-foreground">
                    {detail.plan.domains.map((d) => (
                      <li key={d.fqdn}>
                        <span className="font-mono text-foreground">{d.fqdn}</span> — {d.records.length}{" "}
                        DNS record(s)
                      </li>
                    ))}
                    {detail.plan.databases.length > 0 && (
                      <li>Databases: {detail.plan.databases.join(", ")}</li>
                    )}
                    {detail.plan.mailboxes.length > 0 && (
                      <li>Mailboxes: {detail.plan.mailboxes.join(", ")}</li>
                    )}
                  </ul>
                </div>
              )}
              {detail.log && detail.log.length > 0 && (
                <div>
                  <p className="mb-1 font-medium">Import log</p>
                  <ul className="space-y-1">
                    {detail.log.map((l, i) => (
                      <li key={i} className="flex items-center gap-2">
                        <span
                          className={cn(
                            "rounded px-1.5 py-0.5 text-xs",
                            l.result === "imported"
                              ? "bg-emerald-500/15 text-emerald-400"
                              : l.result === "skipped"
                                ? "bg-amber-500/15 text-amber-400"
                                : "bg-muted text-muted-foreground",
                          )}
                        >
                          {l.result}
                        </span>
                        <span className="font-mono text-xs">{l.item}</span>
                        <span className="text-xs text-muted-foreground">
                          {l.records != null ? `${l.records} records` : l.detail}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
            {detail.status === "planned" && (
              <div className="border-t border-border px-5 py-3 text-right">
                <Button size="sm" disabled={busy} onClick={() => runImport(detail.id)}>
                  Run import
                </Button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
