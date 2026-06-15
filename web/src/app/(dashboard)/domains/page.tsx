"use client";

import { useEffect, useState, type FormEvent } from "react";
import { Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { StatusBadge } from "@/components/ui/badge";
import {
  createDnsRecord,
  createDomain,
  deleteDnsRecord,
  listDnsRecords,
  listDomains,
  type DnsRecord,
  type Domain,
} from "@/lib/api";

const RECORD_TYPES = ["A", "AAAA", "CNAME", "MX", "TXT", "SRV", "NS", "CAA"];

export default function DomainsPage() {
  const [domains, setDomains] = useState<Domain[]>([]);
  const [records, setRecords] = useState<DnsRecord[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // forms
  const [fqdn, setFqdn] = useState("");
  const [recDomain, setRecDomain] = useState("");
  const [recName, setRecName] = useState("@");
  const [recType, setRecType] = useState("A");
  const [recContent, setRecContent] = useState("");
  const [recPriority, setRecPriority] = useState("");
  const [busy, setBusy] = useState(false);

  async function refresh() {
    try {
      const [d, r] = await Promise.all([listDomains(), listDnsRecords()]);
      setDomains(d);
      setRecords(r);
      if (!recDomain && d.length) setRecDomain(d[0].id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    }
  }

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function onAddDomain(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await createDomain(fqdn);
      setNotice(`Domain ${fqdn} added; zone created and dns.apply dispatched.`);
      setFqdn("");
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(false);
    }
  }

  async function onAddRecord(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await createDnsRecord({
        domain_id: recDomain,
        name: recName,
        type: recType,
        content: recContent,
        priority: recPriority ? Number(recPriority) : undefined,
      });
      setNotice("Record added; zone re-applied on the node.");
      setRecContent("");
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(false);
    }
  }

  async function onDeleteRecord(id: string) {
    setError(null);
    try {
      await deleteDnsRecord(id);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
    }
  }

  const selectCls =
    "flex h-9 w-full rounded-md border border-border bg-transparent px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary";

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">Domains &amp; DNS</h1>
        <p className="text-sm text-muted-foreground">
          Adding a domain creates an authoritative zone; every record change dispatches a signed
          <code className="mx-1 rounded bg-muted px-1 text-xs">dns.apply</code> job to the node.
        </p>
      </header>

      {error && <p className="text-sm text-red-400">{error}</p>}
      {notice && <p className="text-sm text-emerald-400">{notice}</p>}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Add domain</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={onAddDomain} className="flex items-end gap-4">
            <div className="flex-1 space-y-1.5">
              <Label htmlFor="fqdn">Domain (FQDN)</Label>
              <Input id="fqdn" value={fqdn} onChange={(e) => setFqdn(e.target.value)} placeholder="acme.com" required />
            </div>
            <Button type="submit" disabled={busy}>
              {busy ? "Adding…" : "Add domain"}
            </Button>
          </form>
        </CardContent>
      </Card>

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
                </tr>
              ))}
              {domains.length === 0 && (
                <tr>
                  <td colSpan={3} className="px-6 py-8 text-center text-muted-foreground">
                    No domains yet — add one above.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Add DNS record</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={onAddRecord} className="grid gap-4 sm:grid-cols-6 sm:items-end">
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="recDomain">Domain</Label>
              <select id="recDomain" value={recDomain} onChange={(e) => setRecDomain(e.target.value)} className={selectCls} required>
                {domains.length === 0 && <option value="">Add a domain first</option>}
                {domains.map((d) => (
                  <option key={d.id} value={d.id} className="bg-card">
                    {d.fqdn}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="recName">Name</Label>
              <Input id="recName" value={recName} onChange={(e) => setRecName(e.target.value)} required />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="recType">Type</Label>
              <select id="recType" value={recType} onChange={(e) => setRecType(e.target.value)} className={selectCls}>
                {RECORD_TYPES.map((t) => (
                  <option key={t} value={t} className="bg-card">
                    {t}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="recContent">Content</Label>
              <Input id="recContent" value={recContent} onChange={(e) => setRecContent(e.target.value)} required />
            </div>
            <Button type="submit" disabled={busy || domains.length === 0}>
              {busy ? "Adding…" : "Add"}
            </Button>
          </form>
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
                <th className="px-6 py-3" />
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
                  <td className="px-6 py-3 font-mono text-xs text-muted-foreground">
                    {r.priority != null ? `${r.priority} ` : ""}
                    {r.content}
                  </td>
                  <td className="px-6 py-3 text-muted-foreground">{r.ttl}</td>
                  <td className="px-6 py-3 text-right">
                    <Button variant="ghost" size="icon" onClick={() => onDeleteRecord(r.id)} title="Delete">
                      <Trash2 className="h-4 w-4 text-muted-foreground" />
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
