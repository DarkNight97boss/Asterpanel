"use client";

import { useEffect, useState, type FormEvent } from "react";
import {
  Forward,
  Globe,
  HardDrive,
  ImageOff,
  List,
  Lock,
  RefreshCw,
  ShieldCheck,
  Trash2,
} from "lucide-react";

import { PageTabs, type PageTab } from "@/components/page-tabs";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { StatusBadge } from "@/components/ui/badge";
import {
  apiDelete,
  apiGet,
  apiPost,
  createDnsRecord,
  createDomain,
  deleteDnsRecord,
  listDnsRecords,
  listDomains,
  type DnsRecord,
  type Domain,
} from "@/lib/api";
import { PageHeader } from "@/components/page-header";

interface Nameserver {
  hostname: string;
  ipv4: string | null;
  label: string | null;
}

interface Redirect {
  id: string;
  source_domain: string;
  source_path: string;
  target_url: string;
  status_code: number;
}

interface Protection {
  id: string;
  domain: string;
  path: string;
  username: string;
}

interface DnssecEntry {
  id: string;
  domain: string;
  ds_record: string;
  algorithm: number;
  enabled: boolean;
}

interface Hotlink {
  id: string;
  domain: string;
  allowed_referers: string[];
  extensions: string[];
}

interface Ddns {
  id: string;
  domain_id: string;
  name: string;
  token: string;
  last_ip: string | null;
  update_url: string;
}

interface Webdav {
  id: string;
  domain: string;
  path: string;
  username: string;
  root: string;
}

const RECORD_TYPES = ["A", "AAAA", "CNAME", "MX", "TXT", "SRV", "NS", "CAA"];

const TABS: PageTab[] = [
  { id: "domains", label: "Domains", icon: Globe },
  { id: "records", label: "DNS Records", icon: List },
  { id: "redirects", label: "Redirects", icon: Forward },
  { id: "privacy", label: "Directory Privacy", icon: Lock },
  { id: "dnssec", label: "DNSSEC", icon: ShieldCheck },
  { id: "hotlink", label: "Hotlink Protection", icon: ImageOff },
  { id: "ddns", label: "Dynamic DNS", icon: RefreshCw },
  { id: "webdisk", label: "Web Disk", icon: HardDrive },
];

export default function DomainsPage() {
  const [domains, setDomains] = useState<Domain[]>([]);
  const [records, setRecords] = useState<DnsRecord[]>([]);
  const [nameservers, setNameservers] = useState<Nameserver[]>([]);
  const [redirects, setRedirects] = useState<Redirect[]>([]);
  const [red, setRed] = useState({ source_domain: "", source_path: "*", target_url: "", status_code: "301" });
  const [protections, setProtections] = useState<Protection[]>([]);
  const [dp, setDp] = useState({ domain: "", path: "/*", username: "", password: "" });
  const [dnssec, setDnssec] = useState<DnssecEntry[]>([]);
  const [dnssecDomain, setDnssecDomain] = useState("");
  const [dnssecBusy, setDnssecBusy] = useState(false);
  const [dnssecResult, setDnssecResult] = useState<{ rdata: string }[] | null>(null);
  const [hotlink, setHotlink] = useState<Hotlink[]>([]);
  const [hl, setHl] = useState({ domain: "", allowed_referers: "", extensions: "" });
  const [hlBusy, setHlBusy] = useState(false);
  const [ddns, setDdns] = useState<Ddns[]>([]);
  const [ddnsForm, setDdnsForm] = useState({ domain_id: "", name: "" });
  const [ddnsBusy, setDdnsBusy] = useState(false);
  const [webdav, setWebdav] = useState<Webdav[]>([]);
  const [wd, setWd] = useState({ domain: "", path: "/webdav/*", username: "", password: "", root: "" });
  const [wdBusy, setWdBusy] = useState(false);
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
  const [tab, setTab] = useState("domains");

  async function refresh() {
    try {
      const [d, r, ns, rd, pr, ds, hk, dd, wv] = await Promise.all([
        listDomains(),
        listDnsRecords(),
        apiGet<{ nameservers: Nameserver[] }>("/api/v1/dns/nameservers").catch(() => ({
          nameservers: [],
        })),
        apiGet<{ redirects: Redirect[] }>("/api/v1/redirects").catch(() => ({ redirects: [] })),
        apiGet<{ protections: Protection[] }>("/api/v1/directory-privacy").catch(() => ({
          protections: [],
        })),
        apiGet<{ dnssec: DnssecEntry[] }>("/api/v1/dns/dnssec").catch(() => ({ dnssec: [] })),
        apiGet<{ hotlink: Hotlink[] }>("/api/v1/hotlink-protection").catch(() => ({ hotlink: [] })),
        apiGet<{ ddns: Ddns[] }>("/api/v1/ddns").catch(() => ({ ddns: [] })),
        apiGet<{ webdav: Webdav[] }>("/api/v1/webdav").catch(() => ({ webdav: [] })),
      ]);
      setDomains(d);
      setRecords(r);
      setNameservers(ns.nameservers ?? []);
      setRedirects(rd.redirects ?? []);
      setProtections(pr.protections ?? []);
      setDnssec(ds.dnssec ?? []);
      setHotlink(hk.hotlink ?? []);
      setDdns(dd.ddns ?? []);
      setWebdav(wv.webdav ?? []);
      if (!recDomain && d.length) setRecDomain(d[0].id);
      if (!ddnsForm.domain_id && d.length) setDdnsForm((f) => ({ ...f, domain_id: d[0].id }));
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

  async function onAddRedirect(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await apiPost("/api/v1/redirects", {
        source_domain: red.source_domain.trim(),
        source_path: red.source_path.trim() || "*",
        target_url: red.target_url.trim(),
        status_code: Number(red.status_code) || 301,
      });
      setNotice("Redirect added; Caddy config re-applied on the node.");
      setRed({ source_domain: "", source_path: "*", target_url: "", status_code: "301" });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(false);
    }
  }

  async function onDeleteRedirect(id: string) {
    setError(null);
    try {
      await apiDelete(`/api/v1/redirects/${id}`);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
    }
  }

  async function onAddDirPrivacy(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await apiPost("/api/v1/directory-privacy", {
        domain: dp.domain.trim(),
        path: dp.path.trim() || "/*",
        username: dp.username.trim(),
        password: dp.password,
      });
      setNotice("Protected path added; Caddy config re-applied on the node.");
      setDp({ domain: "", path: "/*", username: "", password: "" });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(false);
    }
  }

  async function onDeleteDirPrivacy(id: string) {
    setError(null);
    try {
      await apiDelete(`/api/v1/directory-privacy/${id}`);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
    }
  }

  async function onEnableDnssec(e: FormEvent) {
    e.preventDefault();
    setDnssecBusy(true);
    setError(null);
    setDnssecResult(null);
    try {
      const r = await apiPost<{ ds_records: { rdata: string }[] }>("/api/v1/dns/dnssec", {
        domain: dnssecDomain.trim(),
      });
      setDnssecResult(r.ds_records ?? []);
      setDnssecDomain("");
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not enable DNSSEC");
    } finally {
      setDnssecBusy(false);
    }
  }

  async function onDisableDnssec(id: string) {
    setError(null);
    try {
      await apiDelete(`/api/v1/dns/dnssec/${id}`);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
    }
  }

  async function onAddHotlink(e: FormEvent) {
    e.preventDefault();
    setHlBusy(true);
    setError(null);
    setNotice(null);
    try {
      const split = (v: string) =>
        v
          .split(/[\s,]+/)
          .map((s) => s.trim())
          .filter(Boolean);
      await apiPost("/api/v1/hotlink-protection", {
        domain: hl.domain.trim(),
        allowed_referers: split(hl.allowed_referers),
        extensions: split(hl.extensions),
      });
      setNotice("Hotlink protection saved; Caddy config re-applied on the node.");
      setHl({ domain: "", allowed_referers: "", extensions: "" });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
    } finally {
      setHlBusy(false);
    }
  }

  async function onDeleteHotlink(id: string) {
    setError(null);
    try {
      await apiDelete(`/api/v1/hotlink-protection/${id}`);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
    }
  }

  async function onCreateDdns(e: FormEvent) {
    e.preventDefault();
    setDdnsBusy(true);
    setError(null);
    setNotice(null);
    try {
      await apiPost("/api/v1/ddns", {
        domain_id: ddnsForm.domain_id || domains[0]?.id,
        name: ddnsForm.name.trim(),
      });
      setNotice("Dynamic DNS host created — use its update URL from a client.");
      setDdnsForm({ ...ddnsForm, name: "" });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
    } finally {
      setDdnsBusy(false);
    }
  }

  async function onDeleteDdns(id: string) {
    setError(null);
    try {
      await apiDelete(`/api/v1/ddns/${id}`);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
    }
  }

  async function onAddWebdav(e: FormEvent) {
    e.preventDefault();
    setWdBusy(true);
    setError(null);
    setNotice(null);
    try {
      await apiPost("/api/v1/webdav", {
        domain: wd.domain.trim(),
        path: wd.path.trim() || "/webdav/*",
        username: wd.username.trim(),
        password: wd.password,
        root: wd.root.trim(),
      });
      setNotice("Web Disk created; Caddy config re-applied on the node.");
      setWd({ domain: "", path: "/webdav/*", username: "", password: "", root: "" });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
    } finally {
      setWdBusy(false);
    }
  }

  async function onDeleteWebdav(id: string) {
    setError(null);
    try {
      await apiDelete(`/api/v1/webdav/${id}`);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
    }
  }

  const selectCls =
    "flex h-9 w-full rounded-md border border-border bg-transparent px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary";

  return (
    <div className="space-y-6">
      <PageHeader
        title="Domains & DNS"
        description={
          <>
            Adding a domain creates an authoritative zone; every record change dispatches a signed
            <code className="mx-1 rounded bg-muted px-1 text-xs">dns.apply</code> job to the node.
          </>
        }
      />

      {error && <p className="text-sm text-red-600">{error}</p>}
      {notice && <p className="text-sm text-emerald-600">{notice}</p>}

      <PageTabs tabs={TABS} active={tab} onChange={setTab} />

      {tab === "domains" && (
        <>
          {nameservers.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Nameservers</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="mb-3 text-sm text-muted-foreground">
              Point your domain at these nameservers at your registrar. Every zone is replicated
              across the fleet for redundancy (secondary DNS).
            </p>
            <div className="grid gap-3 sm:grid-cols-2">
              {nameservers.map((n) => (
                <div
                  key={n.hostname}
                  className="flex items-center justify-between rounded-md border border-border px-4 py-2.5 text-sm"
                >
                  <div>
                    <div className="font-mono">{n.hostname}</div>
                    {n.ipv4 && <div className="font-mono text-xs text-muted-foreground">{n.ipv4}</div>}
                  </div>
                  {n.label && (
                    <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                      {n.label}
                    </span>
                  )}
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

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
        </>
      )}

      {tab === "records" && (
        <>
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
        </>
      )}

      {tab === "redirects" && (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Redirects ({redirects.length})</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Send a domain (or a path under it) to another URL. Use{" "}
            <code className="rounded bg-muted px-1 py-0.5 text-xs">*</code> as the path for a
            whole-domain redirect that preserves the original path.
          </p>
          <form onSubmit={onAddRedirect} className="grid gap-3 sm:grid-cols-6 sm:items-end">
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="red-domain">Source domain</Label>
              <Input
                id="red-domain"
                value={red.source_domain}
                onChange={(e) => setRed({ ...red, source_domain: e.target.value })}
                placeholder="old.acme.com"
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="red-path">Path</Label>
              <Input
                id="red-path"
                value={red.source_path}
                onChange={(e) => setRed({ ...red, source_path: e.target.value })}
                placeholder="*"
              />
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="red-target">Target URL</Label>
              <Input
                id="red-target"
                value={red.target_url}
                onChange={(e) => setRed({ ...red, target_url: e.target.value })}
                placeholder="https://acme.com"
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="red-code">Code</Label>
              <select
                id="red-code"
                className={selectCls}
                value={red.status_code}
                onChange={(e) => setRed({ ...red, status_code: e.target.value })}
              >
                {["301", "302", "307", "308"].map((c) => (
                  <option key={c} value={c} className="bg-card">
                    {c}
                  </option>
                ))}
              </select>
            </div>
            <Button type="submit" disabled={busy} className="sm:col-span-6 sm:w-fit">
              {busy ? "Adding…" : "Add redirect"}
            </Button>
          </form>

          {redirects.length > 0 && (
            <ul className="divide-y divide-border/60 rounded-md border border-border/60">
              {redirects.map((rd) => (
                <li key={rd.id} className="flex items-center gap-3 px-4 py-2 text-sm">
                  <span className="font-mono">
                    {rd.source_domain}
                    {rd.source_path !== "*" ? rd.source_path : ""}
                  </span>
                  <span className="text-muted-foreground">→</span>
                  <span className="font-mono text-xs text-muted-foreground">{rd.target_url}</span>
                  <span className="rounded bg-muted px-1.5 py-0.5 text-[11px]">{rd.status_code}</span>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="ml-auto h-7 w-7"
                    onClick={() => onDeleteRedirect(rd.id)}
                    aria-label="Delete redirect"
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
      )}

      {tab === "privacy" && (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Directory privacy ({protections.length})</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Password-protect a path with HTTP basic auth. The password is stored only as a bcrypt
            hash and rendered into the Caddy config.
          </p>
          <form onSubmit={onAddDirPrivacy} className="grid gap-3 sm:grid-cols-5 sm:items-end">
            <div className="space-y-1.5">
              <Label htmlFor="dp-domain">Domain</Label>
              <Input
                id="dp-domain"
                value={dp.domain}
                onChange={(e) => setDp({ ...dp, domain: e.target.value })}
                placeholder="acme.com"
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="dp-path">Path</Label>
              <Input
                id="dp-path"
                value={dp.path}
                onChange={(e) => setDp({ ...dp, path: e.target.value })}
                placeholder="/admin/*"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="dp-user">Username</Label>
              <Input
                id="dp-user"
                value={dp.username}
                onChange={(e) => setDp({ ...dp, username: e.target.value })}
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="dp-pass">Password</Label>
              <Input
                id="dp-pass"
                type="password"
                value={dp.password}
                onChange={(e) => setDp({ ...dp, password: e.target.value })}
                placeholder="min 6 chars"
                required
              />
            </div>
            <Button type="submit" disabled={busy}>
              {busy ? "Adding…" : "Protect"}
            </Button>
          </form>

          {protections.length > 0 && (
            <ul className="divide-y divide-border/60 rounded-md border border-border/60">
              {protections.map((pr) => (
                <li key={pr.id} className="flex items-center gap-3 px-4 py-2 text-sm">
                  <span className="font-mono">
                    {pr.domain}
                    {pr.path}
                  </span>
                  <span className="text-muted-foreground">·</span>
                  <span className="text-xs text-muted-foreground">user: {pr.username}</span>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="ml-auto h-7 w-7"
                    onClick={() => onDeleteDirPrivacy(pr.id)}
                    aria-label="Delete protection"
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
      )}

      {tab === "dnssec" && (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">DNSSEC ({dnssec.length})</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Sign a zone and publish the printed <strong>DS record</strong> at your registrar to
            enable DNSSEC validation.
          </p>
          <form onSubmit={onEnableDnssec} className="flex flex-wrap items-end gap-3">
            <div className="grow space-y-1.5">
              <Label htmlFor="dnssec-domain">Domain</Label>
              <Input
                id="dnssec-domain"
                value={dnssecDomain}
                onChange={(e) => setDnssecDomain(e.target.value)}
                placeholder="acme.com"
                required
              />
            </div>
            <Button type="submit" disabled={dnssecBusy}>
              {dnssecBusy ? "Signing…" : "Enable DNSSEC"}
            </Button>
          </form>

          {dnssecResult && (
            <div className="space-y-1 rounded-md border border-border bg-muted/30 p-3 font-mono text-xs">
              <p className="font-sans text-muted-foreground">
                Publish this DS record at your registrar:
              </p>
              {dnssecResult.map((d) => (
                <div key={d.rdata} className="break-all">
                  <span className="text-emerald-600">DS</span> {d.rdata}
                </div>
              ))}
            </div>
          )}

          {dnssec.length > 0 && (
            <ul className="divide-y divide-border/60 rounded-md border border-border/60">
              {dnssec.map((d) => (
                <li key={d.id} className="flex items-center gap-3 px-4 py-2 text-sm">
                  <span className="font-mono">{d.domain}</span>
                  <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-[11px] text-emerald-600">
                    signed
                  </span>
                  <span className="truncate font-mono text-xs text-muted-foreground">
                    DS {d.ds_record}
                  </span>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="ml-auto h-7 w-7 shrink-0"
                    onClick={() => onDisableDnssec(d.id)}
                    aria-label="Disable DNSSEC"
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
      )}

      {tab === "hotlink" && (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Hotlink protection ({hotlink.length})</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Block other sites from embedding your assets (images, etc.). The domain itself is always
            allowed; add extra referers (e.g. a CDN). Leave extensions empty for the image defaults.
          </p>
          <form onSubmit={onAddHotlink} className="grid gap-3 sm:grid-cols-4 sm:items-end">
            <div className="space-y-1.5">
              <Label htmlFor="hl-domain">Domain</Label>
              <Input
                id="hl-domain"
                value={hl.domain}
                onChange={(e) => setHl({ ...hl, domain: e.target.value })}
                placeholder="acme.com"
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="hl-ref">Allowed referers</Label>
              <Input
                id="hl-ref"
                value={hl.allowed_referers}
                onChange={(e) => setHl({ ...hl, allowed_referers: e.target.value })}
                placeholder="cdn.acme.com"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="hl-ext">Extensions</Label>
              <Input
                id="hl-ext"
                value={hl.extensions}
                onChange={(e) => setHl({ ...hl, extensions: e.target.value })}
                placeholder="jpg, png, gif"
              />
            </div>
            <Button type="submit" disabled={hlBusy}>
              {hlBusy ? "Saving…" : "Protect"}
            </Button>
          </form>

          {hotlink.length > 0 && (
            <ul className="divide-y divide-border/60 rounded-md border border-border/60">
              {hotlink.map((h) => (
                <li key={h.id} className="flex items-center gap-3 px-4 py-2 text-sm">
                  <span className="font-mono">{h.domain}</span>
                  <span className="text-xs text-muted-foreground">
                    {(h.extensions.length ? h.extensions : ["images"]).join(", ")}
                    {h.allowed_referers.length ? ` · +${h.allowed_referers.join(", ")}` : ""}
                  </span>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="ml-auto h-7 w-7"
                    onClick={() => onDeleteHotlink(h.id)}
                    aria-label="Delete hotlink rule"
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
      )}

      {tab === "ddns" && (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Dynamic DNS ({ddns.length})</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Keep an A record pointed at a changing IP. A client (router, script) calls the host&apos;s
            update URL with its token; the record follows the caller&apos;s IP.
          </p>
          <form onSubmit={onCreateDdns} className="grid gap-3 sm:grid-cols-4 sm:items-end">
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="ddns-domain">Domain</Label>
              <select
                id="ddns-domain"
                className={selectCls}
                value={ddnsForm.domain_id}
                onChange={(e) => setDdnsForm({ ...ddnsForm, domain_id: e.target.value })}
              >
                {domains.length === 0 && <option value="">Add a domain first</option>}
                {domains.map((d) => (
                  <option key={d.id} value={d.id} className="bg-card">
                    {d.fqdn}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ddns-name">Record name</Label>
              <Input
                id="ddns-name"
                value={ddnsForm.name}
                onChange={(e) => setDdnsForm({ ...ddnsForm, name: e.target.value })}
                placeholder="home"
                required
              />
            </div>
            <Button type="submit" disabled={ddnsBusy || domains.length === 0}>
              {ddnsBusy ? "Creating…" : "Create host"}
            </Button>
          </form>

          {ddns.length > 0 && (
            <ul className="divide-y divide-border/60 rounded-md border border-border/60">
              {ddns.map((h) => (
                <li key={h.id} className="space-y-1 px-4 py-2 text-sm">
                  <div className="flex items-center gap-3">
                    <span className="font-mono">{h.name}</span>
                    <span className="text-xs text-muted-foreground">
                      → {h.last_ip ?? "not updated yet"}
                    </span>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="ml-auto h-7 w-7"
                      onClick={() => onDeleteDdns(h.id)}
                      aria-label="Delete dynamic DNS host"
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                  <code className="block break-all rounded bg-muted px-2 py-1 text-[11px] text-muted-foreground">
                    {h.update_url}
                  </code>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
      )}

      {tab === "webdisk" && (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Web Disk (WebDAV) ({webdav.length})</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Serve a folder over WebDAV behind HTTP basic-auth — mount it as a network drive. The
            password is stored only as a bcrypt hash.
          </p>
          <form onSubmit={onAddWebdav} className="grid gap-3 sm:grid-cols-6 sm:items-end">
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="wd-domain">Domain</Label>
              <Input
                id="wd-domain"
                value={wd.domain}
                onChange={(e) => setWd({ ...wd, domain: e.target.value })}
                placeholder="acme.com"
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="wd-path">Path</Label>
              <Input
                id="wd-path"
                value={wd.path}
                onChange={(e) => setWd({ ...wd, path: e.target.value })}
                placeholder="/webdav/*"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="wd-user">Username</Label>
              <Input
                id="wd-user"
                value={wd.username}
                onChange={(e) => setWd({ ...wd, username: e.target.value })}
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="wd-pass">Password</Label>
              <Input
                id="wd-pass"
                type="password"
                value={wd.password}
                onChange={(e) => setWd({ ...wd, password: e.target.value })}
                placeholder="min 6 chars"
                required
              />
            </div>
            <Button type="submit" disabled={wdBusy}>
              {wdBusy ? "Creating…" : "Create"}
            </Button>
            <div className="space-y-1.5 sm:col-span-6">
              <Label htmlFor="wd-root">Served folder (absolute path on the node)</Label>
              <Input
                id="wd-root"
                value={wd.root}
                onChange={(e) => setWd({ ...wd, root: e.target.value })}
                placeholder="/var/asterpanel/sites/acme"
                required
              />
            </div>
          </form>

          {webdav.length > 0 && (
            <ul className="divide-y divide-border/60 rounded-md border border-border/60">
              {webdav.map((a) => (
                <li key={a.id} className="flex items-center gap-3 px-4 py-2 text-sm">
                  <span className="font-mono">
                    {a.domain}
                    {a.path}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {a.username} · {a.root}
                  </span>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="ml-auto h-7 w-7"
                    onClick={() => onDeleteWebdav(a.id)}
                    aria-label="Delete web disk"
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
      )}
    </div>
  );
}
