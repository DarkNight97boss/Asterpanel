"use client";

import { useEffect, useState, type FormEvent } from "react";
import { Cloud, Pencil, Plus, RefreshCw, Trash2, Unplug, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { apiDelete, apiGet, apiPost } from "@/lib/api";
import { PageHeader } from "@/components/page-header";

interface CFStatus {
  connected: boolean;
  label?: string;
  verified_at?: string | null;
}
interface Zone {
  id: string;
  name: string;
  status: string;
}
interface DNSRecord {
  id: string;
  type: string;
  name: string;
  content: string;
  proxied: boolean;
  ttl: number;
}

const RECORD_TYPES = ["A", "AAAA", "CNAME", "TXT", "MX", "NS", "CAA", "SRV"];

export default function CDNPage() {
  const [status, setStatus] = useState<CFStatus>({ connected: false });
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [token, setToken] = useState("");
  const [label, setLabel] = useState("");
  const [connecting, setConnecting] = useState(false);

  const [zones, setZones] = useState<Zone[]>([]);
  const [zoneId, setZoneId] = useState("");
  const [records, setRecords] = useState<DNSRecord[]>([]);
  const [purging, setPurging] = useState(false);

  const [recType, setRecType] = useState("A");
  const [recName, setRecName] = useState("");
  const [recContent, setRecContent] = useState("");
  const [recProxied, setRecProxied] = useState(true);
  const [editRecId, setEditRecId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  async function loadStatus() {
    try {
      const s = await apiGet<CFStatus>("/api/v1/cdn/cloudflare");
      setStatus(s);
      if (s.connected) await loadZones();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    }
  }
  useEffect(() => {
    loadStatus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function loadZones() {
    try {
      const r = await apiGet<{ zones: Zone[] }>("/api/v1/cdn/cloudflare/zones");
      setZones(r.zones ?? []);
      if ((r.zones ?? []).length && !zoneId) {
        setZoneId(r.zones[0].id);
        await loadRecords(r.zones[0].id);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load zones");
    }
  }

  async function loadRecords(zid: string) {
    if (!zid) return;
    try {
      const r = await apiGet<{ records: DNSRecord[] }>(`/api/v1/cdn/cloudflare/zones/${zid}/dns`);
      setRecords(r.records ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load records");
    }
  }

  async function connect(e: FormEvent) {
    e.preventDefault();
    setConnecting(true);
    setError(null);
    setNotice(null);
    try {
      await apiPost("/api/v1/cdn/cloudflare", { token: token.trim(), label: label.trim() });
      setToken("");
      setNotice("Cloudflare connected.");
      await loadStatus();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not connect Cloudflare");
    } finally {
      setConnecting(false);
    }
  }

  async function disconnect() {
    setError(null);
    try {
      await apiDelete("/api/v1/cdn/cloudflare");
      setStatus({ connected: false });
      setZones([]);
      setRecords([]);
      setZoneId("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not disconnect");
    }
  }

  async function selectZone(zid: string) {
    setZoneId(zid);
    await loadRecords(zid);
  }

  function startEditRecord(rec: DNSRecord) {
    setEditRecId(rec.id);
    setRecType(rec.type);
    setRecName(rec.name);
    setRecContent(rec.content);
    setRecProxied(rec.proxied);
  }
  function cancelEditRecord() {
    setEditRecId(null);
    setRecName("");
    setRecContent("");
    setRecProxied(true);
  }

  async function addRecord(e: FormEvent) {
    e.preventDefault();
    if (!zoneId) return;
    setAdding(true);
    setError(null);
    try {
      const payload = {
        type: recType,
        name: recName.trim(),
        content: recContent.trim(),
        proxied: recProxied,
      };
      if (editRecId) {
        await apiPost(`/api/v1/cdn/cloudflare/zones/${zoneId}/dns/${editRecId}`, payload);
        setEditRecId(null);
      } else {
        await apiPost(`/api/v1/cdn/cloudflare/zones/${zoneId}/dns`, payload);
      }
      setRecName("");
      setRecContent("");
      await loadRecords(zoneId);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save record");
    } finally {
      setAdding(false);
    }
  }

  async function deleteRecord(id: string) {
    if (!zoneId) return;
    setError(null);
    try {
      await apiDelete(`/api/v1/cdn/cloudflare/zones/${zoneId}/dns/${id}`);
      await loadRecords(zoneId);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not delete record");
    }
  }

  async function purge() {
    if (!zoneId) return;
    setPurging(true);
    setError(null);
    setNotice(null);
    try {
      await apiPost(`/api/v1/cdn/cloudflare/zones/${zoneId}/purge`, {});
      setNotice("Cache purge requested for this zone.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not purge cache");
    } finally {
      setPurging(false);
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="CDN"
        description="Connect a Cloudflare API token to manage your zones' DNS records and purge the CDN cache directly from the panel. The token is verified on connect and stored encrypted."
      />

      {error && <p className="text-sm text-red-600">{error}</p>}
      {notice && <p className="text-sm text-emerald-600">{notice}</p>}

      {!status.connected ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Connect Cloudflare</CardTitle>
          </CardHeader>
          <CardContent>
            <form onSubmit={connect} className="space-y-4">
              <p className="text-sm text-muted-foreground">
                Create an API token in Cloudflare with <code>Zone.DNS</code> edit and{" "}
                <code>Zone.Cache Purge</code> permissions, then paste it here.
              </p>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="cf-token">API token</Label>
                  <Input
                    id="cf-token"
                    type="password"
                    value={token}
                    onChange={(e) => setToken(e.target.value)}
                    className="font-mono"
                    required
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="cf-label">Label (optional)</Label>
                  <Input id="cf-label" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Acme Cloudflare" />
                </div>
              </div>
              <Button type="submit" disabled={connecting}>
                <Cloud className="h-4 w-4" />
                {connecting ? "Verifying…" : "Connect"}
              </Button>
            </form>
          </CardContent>
        </Card>
      ) : (
        <>
          <Card>
            <CardHeader className="flex-row items-center justify-between space-y-0">
              <CardTitle className="text-base">
                <span className="inline-flex items-center gap-2">
                  <Cloud className="h-4 w-4 text-amber-500" />
                  Cloudflare connected
                  {status.label ? <span className="text-muted-foreground">· {status.label}</span> : null}
                </span>
              </CardTitle>
              <Button variant="ghost" size="sm" onClick={disconnect}>
                <Unplug className="h-4 w-4" />
                Disconnect
              </Button>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex flex-wrap items-center gap-3">
                <label htmlFor="cf-zone" className="text-sm text-muted-foreground">
                  Zone
                </label>
                <select
                  id="cf-zone"
                  className="h-9 max-w-xs rounded-md border border-border bg-transparent px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                  value={zoneId}
                  onChange={(e) => selectZone(e.target.value)}
                >
                  {zones.length === 0 && <option value="">no zones</option>}
                  {zones.map((z) => (
                    <option key={z.id} value={z.id} className="bg-card">
                      {z.name} ({z.status})
                    </option>
                  ))}
                </select>
                <Button variant="outline" size="sm" onClick={purge} disabled={purging || !zoneId}>
                  <RefreshCw className="h-4 w-4" />
                  {purging ? "Purging…" : "Purge cache"}
                </Button>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">DNS records ({records.length})</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <form onSubmit={addRecord} className="grid gap-3 sm:grid-cols-[auto_1fr_1fr_auto_auto] sm:items-end">
                <div className="space-y-1.5">
                  <Label htmlFor="rec-type">Type</Label>
                  <select
                    id="rec-type"
                    className="flex h-9 rounded-md border border-border bg-transparent px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                    value={recType}
                    onChange={(e) => setRecType(e.target.value)}
                  >
                    {RECORD_TYPES.map((t) => (
                      <option key={t} value={t} className="bg-card">
                        {t}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="rec-name">Name</Label>
                  <Input id="rec-name" value={recName} onChange={(e) => setRecName(e.target.value)} placeholder="www" className="font-mono" required />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="rec-content">Content</Label>
                  <Input id="rec-content" value={recContent} onChange={(e) => setRecContent(e.target.value)} placeholder="203.0.113.5" className="font-mono" required />
                </div>
                <label className="flex h-9 items-center gap-2 text-sm text-muted-foreground">
                  <input type="checkbox" checked={recProxied} onChange={(e) => setRecProxied(e.target.checked)} />
                  proxied
                </label>
                <Button type="submit" disabled={adding || !zoneId}>
                  <Plus className="h-4 w-4" />
                  {adding ? "Saving…" : editRecId ? "Save" : "Add"}
                </Button>
                {editRecId && (
                  <Button type="button" variant="ghost" size="icon" onClick={cancelEditRecord} aria-label="Cancel">
                    <X className="h-4 w-4" />
                  </Button>
                )}
              </form>

              <table className="w-full text-sm">
                <thead className="border-b border-border text-left text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 font-medium">Type</th>
                    <th className="px-3 py-2 font-medium">Name</th>
                    <th className="px-3 py-2 font-medium">Content</th>
                    <th className="px-3 py-2 font-medium">Proxy</th>
                    <th className="px-3 py-2" />
                  </tr>
                </thead>
                <tbody>
                  {records.map((rec) => (
                    <tr key={rec.id} className={`border-b border-border/60 last:border-0 ${editRecId === rec.id ? "bg-muted/60" : ""}`}>
                      <td className="px-3 py-2 font-mono text-xs">{rec.type}</td>
                      <td className="px-3 py-2 font-mono text-xs">{rec.name}</td>
                      <td className="px-3 py-2 font-mono text-xs text-muted-foreground">{rec.content}</td>
                      <td className="px-3 py-2 text-xs">
                        {rec.proxied ? (
                          <span className="text-amber-500">proxied</span>
                        ) : (
                          <span className="text-muted-foreground">DNS only</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right">
                        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => startEditRecord(rec)} aria-label="Edit record">
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => deleteRecord(rec.id)} aria-label="Delete record">
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </td>
                    </tr>
                  ))}
                  {records.length === 0 && (
                    <tr>
                      <td colSpan={5} className="px-3 py-6 text-center text-muted-foreground">
                        No records in this zone.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
