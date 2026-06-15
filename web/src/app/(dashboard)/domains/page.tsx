"use client";

import { useEffect, useState } from "react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { StatusBadge } from "@/components/ui/badge";
import { listDnsRecords, listDomains, type DnsRecord, type Domain } from "@/lib/api";

export default function DomainsPage() {
  const [domains, setDomains] = useState<Domain[]>([]);
  const [records, setRecords] = useState<DnsRecord[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([listDomains(), listDnsRecords()])
      .then(([d, r]) => {
        setDomains(d);
        setRecords(r);
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Failed to load"));
  }, []);

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">Domains &amp; DNS</h1>
        <p className="text-sm text-muted-foreground">
          Verify domains, manage zones and records. ACME issues TLS automatically.
        </p>
      </header>

      {error && <p className="text-sm text-red-400">{error}</p>}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Domains ({domains.length})</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <table className="w-full text-sm">
            <thead className="border-b border-border text-left text-muted-foreground">
              <tr>
                <th className="px-6 py-3 font-medium">Domain</th>
                <th className="px-6 py-3 font-medium">Status</th>
                <th className="px-6 py-3 font-medium">Auto-renew</th>
                <th className="px-6 py-3 font-medium">Verified</th>
              </tr>
            </thead>
            <tbody>
              {domains.map((d) => (
                <tr key={d.id} className="border-b border-border/60 last:border-0">
                  <td className="px-6 py-3 font-medium">{d.fqdn}</td>
                  <td className="px-6 py-3">
                    <StatusBadge status={d.status} />
                  </td>
                  <td className="px-6 py-3 text-muted-foreground">{d.auto_renew ? "on" : "off"}</td>
                  <td className="px-6 py-3 text-muted-foreground">
                    {d.verified_at ? new Date(d.verified_at).toLocaleDateString() : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">DNS records ({records.length})</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <table className="w-full text-sm">
            <thead className="border-b border-border text-left text-muted-foreground">
              <tr>
                <th className="px-6 py-3 font-medium">Type</th>
                <th className="px-6 py-3 font-medium">Name</th>
                <th className="px-6 py-3 font-medium">Content</th>
                <th className="px-6 py-3 font-medium">TTL</th>
                <th className="px-6 py-3 font-medium">Prio</th>
              </tr>
            </thead>
            <tbody>
              {records.map((r) => (
                <tr key={r.id} className="border-b border-border/60 last:border-0">
                  <td className="px-6 py-3">
                    <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{r.type}</span>
                  </td>
                  <td className="px-6 py-3 text-muted-foreground">
                    {r.name === "@" ? r.zone : `${r.name}.${r.zone}`}
                  </td>
                  <td className="px-6 py-3 font-mono text-xs text-muted-foreground">{r.content}</td>
                  <td className="px-6 py-3 text-muted-foreground">{r.ttl}</td>
                  <td className="px-6 py-3 text-muted-foreground">{r.priority ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}
