"use client";

import { useEffect, useState, type FormEvent } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { apiGet, apiPost } from "@/lib/api";

interface Mailbox {
  id: string;
  address: string;
  quota_mb: number;
  used_mb: number;
  status: string;
}

export default function EmailPage() {
  const [boxes, setBoxes] = useState<Mailbox[]>([]);
  const [address, setAddress] = useState("");
  const [quota, setQuota] = useState("1024");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [password, setPassword] = useState<string | null>(null);
  const [dkimDomain, setDkimDomain] = useState("");
  const [dkimBusy, setDkimBusy] = useState(false);
  const [dkim, setDkim] = useState<{
    domain: string;
    record: { name: string; type: string; content: string };
    spf: { name: string; content: string };
    dmarc: { name: string; content: string };
  } | null>(null);

  async function generateDkim(e: FormEvent) {
    e.preventDefault();
    setDkimBusy(true);
    setError(null);
    try {
      const r = await apiPost<typeof dkim>("/api/v1/email/dkim", { domain: dkimDomain });
      setDkim(r);
    } catch (err) {
      setError(err instanceof Error ? err.message : "DKIM generation failed");
    } finally {
      setDkimBusy(false);
    }
  }

  async function refresh() {
    try {
      const { mailboxes } = await apiGet<{ mailboxes: Mailbox[] }>("/api/v1/email/mailboxes");
      setBoxes(mailboxes);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
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
      const res = await apiPost<{ password?: string }>("/api/v1/email/mailboxes", {
        address,
        quota_mb: Number(quota),
      });
      if (res.password) setPassword(res.password);
      setAddress("");
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
        <h1 className="text-2xl font-semibold">Mailboxes</h1>
        <p className="text-sm text-muted-foreground">
          IMAP/SMTP mailboxes with quotas, SPF/DKIM signing and spam filtering.
        </p>
      </header>

      {error && <p className="text-sm text-red-400">{error}</p>}
      {password && (
        <Card className="border-primary/40">
          <CardHeader>
            <CardTitle className="text-base">Mailbox password (shown once)</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <pre className="overflow-x-auto rounded-md bg-muted p-3 text-xs">{password}</pre>
            <Button variant="outline" size="sm" onClick={() => setPassword(null)}>
              Dismiss
            </Button>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Deliverability — DKIM / SPF / DMARC</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Generate a DKIM keypair on the mail server and publish the printed records at your DNS
            registrar. Antispam (Rspamd) and antivirus (ClamAV) are enabled on the mail server.
          </p>
          <form onSubmit={generateDkim} className="flex flex-wrap items-end gap-3">
            <div className="grow space-y-1">
              <Label htmlFor="dkim-domain">Mail domain</Label>
              <Input
                id="dkim-domain"
                placeholder="acme.com"
                value={dkimDomain}
                onChange={(e) => setDkimDomain(e.target.value)}
                required
              />
            </div>
            <Button type="submit" disabled={dkimBusy}>
              Generate DKIM
            </Button>
          </form>
          {dkim && (
            <div className="space-y-2 rounded-md border border-border bg-muted/30 p-3 font-mono text-xs">
              <p className="font-sans text-muted-foreground">
                Publish these records at your registrar:
              </p>
              <div>
                <span className="text-emerald-400">DKIM</span> {dkim.record.name}{" "}
                <span className="text-muted-foreground">TTL {3600}</span>
                <div className="break-all">{dkim.record.content || <em>see node logs</em>}</div>
              </div>
              <div>
                <span className="text-emerald-400">SPF </span> {dkim.spf.name} ·{" "}
                {dkim.spf.content}
              </div>
              <div>
                <span className="text-emerald-400">DMARC</span> {dkim.dmarc.name} ·{" "}
                {dkim.dmarc.content}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">New mailbox</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={onCreate} className="grid gap-4 sm:grid-cols-4 sm:items-end">
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="address">Address</Label>
              <Input id="address" type="email" value={address} onChange={(e) => setAddress(e.target.value)} placeholder="hello@acme.com" required />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="quota">Quota (MB)</Label>
              <Input id="quota" type="number" value={quota} onChange={(e) => setQuota(e.target.value)} />
            </div>
            <Button type="submit" disabled={busy}>
              {busy ? "Creating…" : "Create"}
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Mailboxes ({boxes.length})</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <table className="w-full text-sm">
            <thead className="border-b border-border text-left text-muted-foreground">
              <tr>
                <th className="px-6 py-3 font-medium">Address</th>
                <th className="px-6 py-3 font-medium">Usage</th>
                <th className="px-6 py-3 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {boxes.map((b) => (
                <tr key={b.id} className="border-b border-border/60 last:border-0">
                  <td className="px-6 py-3 font-medium">{b.address}</td>
                  <td className="px-6 py-3">
                    <div className="flex items-center gap-3">
                      <div className="h-1.5 w-32 overflow-hidden rounded-full bg-muted">
                        <div
                          className="h-full rounded-full bg-primary"
                          style={{ width: `${Math.min(100, (b.used_mb / b.quota_mb) * 100)}%` }}
                        />
                      </div>
                      <span className="text-xs text-muted-foreground">
                        {b.used_mb} / {b.quota_mb} MB
                      </span>
                    </div>
                  </td>
                  <td className="px-6 py-3 text-muted-foreground">{b.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}
