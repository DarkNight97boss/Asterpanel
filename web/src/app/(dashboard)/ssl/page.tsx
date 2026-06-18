"use client";

import { useEffect, useState, type FormEvent } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { StatusBadge } from "@/components/ui/badge";
import { apiGet, apiPost } from "@/lib/api";
import { PageHeader } from "@/components/page-header";

interface Cert {
  id: string;
  domain: string;
  issuer: string;
  status: string;
  expires_at: string | null;
  auto_renew: boolean;
}

export default function SslPage() {
  const [certs, setCerts] = useState<Cert[]>([]);
  const [domain, setDomain] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    try {
      const { certificates } = await apiGet<{ certificates: Cert[] }>("/api/v1/ssl-certificates");
      setCerts(certificates);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    }
  }
  useEffect(() => {
    refresh();
  }, []);

  async function onIssue(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await apiPost("/api/v1/ssl-certificates", { domain });
      setDomain("");
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="SSL / TLS"
        description="Automatic certificates via Let's Encrypt (ACME). Auto-renewed before expiry."
      />

      {error && <p className="text-sm text-red-600">{error}</p>}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Issue a certificate</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={onIssue} className="flex items-end gap-4">
            <div className="flex-1 space-y-1.5">
              <Label htmlFor="domain">Domain</Label>
              <Input id="domain" value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="app.acme.com" required />
            </div>
            <Button type="submit" disabled={busy}>
              {busy ? "Requesting…" : "Issue"}
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Certificates ({certs.length})</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <table className="w-full text-sm">
            <thead className="border-b border-border text-left text-muted-foreground">
              <tr>
                <th className="px-6 py-3 font-medium">Domain</th>
                <th className="px-6 py-3 font-medium">Issuer</th>
                <th className="px-6 py-3 font-medium">Status</th>
                <th className="px-6 py-3 font-medium">Expires</th>
                <th className="px-6 py-3 font-medium">Auto-renew</th>
              </tr>
            </thead>
            <tbody>
              {certs.map((c) => (
                <tr key={c.id} className="border-b border-border/60 last:border-0">
                  <td className="px-6 py-3 font-medium">{c.domain}</td>
                  <td className="px-6 py-3 text-muted-foreground">{c.issuer}</td>
                  <td className="px-6 py-3">
                    <StatusBadge status={c.status} />
                  </td>
                  <td className="px-6 py-3 text-muted-foreground">
                    {c.expires_at ? new Date(c.expires_at).toLocaleDateString() : "—"}
                  </td>
                  <td className="px-6 py-3 text-muted-foreground">{c.auto_renew ? "on" : "off"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}
