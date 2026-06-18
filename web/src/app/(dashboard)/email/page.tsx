"use client";

import { useEffect, useState, type FormEvent } from "react";
import { Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { apiDelete, apiGet, apiPost, apiPut } from "@/lib/api";
import { PageHeader } from "@/components/page-header";

interface Mailbox {
  id: string;
  address: string;
  quota_mb: number;
  used_mb: number;
  status: string;
}

interface Forwarder {
  id: string;
  source: string;
  destinations: string[];
  is_catchall: boolean;
}

interface Autoresponder {
  id: string;
  address: string;
  subject: string;
  body: string;
  interval_days: number;
  start_date: string;
  end_date: string;
  enabled: boolean;
}

interface Filter {
  id: string;
  address: string;
  name: string;
  field: string;
  op: string;
  value: string;
  action: string;
  action_arg: string;
  position: number;
  enabled: boolean;
}

const selectCls =
  "flex h-9 w-full rounded-md border border-border bg-background px-3 py-1 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary";

interface SpamSettings {
  reject_score: number;
  add_header_score: number;
  greylisting: boolean;
}

interface SpamRule {
  id: string;
  kind: string;
  value: string;
}

interface ListMember {
  id: string;
  email: string;
}

interface MailList {
  id: string;
  address: string;
  members: ListMember[];
  member_count: number;
}

interface CaldavAccount {
  id: string;
  username: string;
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
  const [forwarders, setForwarders] = useState<Forwarder[]>([]);
  const [fwdSource, setFwdSource] = useState("");
  const [fwdDests, setFwdDests] = useState("");
  const [fwdBusy, setFwdBusy] = useState(false);

  async function refreshForwarders() {
    try {
      const { forwarders } = await apiGet<{ forwarders: Forwarder[] }>("/api/v1/email/forwarders");
      setForwarders(forwarders);
    } catch {
      /* the section just stays empty if the backend is unreachable */
    }
  }

  async function onCreateForwarder(e: FormEvent) {
    e.preventDefault();
    setFwdBusy(true);
    setError(null);
    try {
      const destinations = fwdDests
        .split(/[\s,]+/)
        .map((d) => d.trim())
        .filter(Boolean);
      await apiPost("/api/v1/email/forwarders", { source: fwdSource.trim(), destinations });
      setFwdSource("");
      setFwdDests("");
      await refreshForwarders();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not create forwarder");
    } finally {
      setFwdBusy(false);
    }
  }

  async function onDeleteForwarder(id: string) {
    try {
      await apiDelete(`/api/v1/email/forwarders/${id}`);
      await refreshForwarders();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not delete forwarder");
    }
  }

  const [autoresponders, setAutoresponders] = useState<Autoresponder[]>([]);
  const [ar, setAr] = useState({
    address: "",
    subject: "",
    body: "",
    interval_days: "1",
    start_date: "",
    end_date: "",
  });
  const [arBusy, setArBusy] = useState(false);

  async function refreshAutoresponders() {
    try {
      const { autoresponders } = await apiGet<{ autoresponders: Autoresponder[] }>(
        "/api/v1/email/autoresponders",
      );
      setAutoresponders(autoresponders);
    } catch {
      /* keep the section empty if the backend is unreachable */
    }
  }

  async function onCreateAutoresponder(e: FormEvent) {
    e.preventDefault();
    setArBusy(true);
    setError(null);
    try {
      await apiPost("/api/v1/email/autoresponders", {
        address: ar.address.trim(),
        subject: ar.subject.trim(),
        body: ar.body,
        interval_days: Number(ar.interval_days) || 1,
        start_date: ar.start_date,
        end_date: ar.end_date,
      });
      setAr({ address: "", subject: "", body: "", interval_days: "1", start_date: "", end_date: "" });
      await refreshAutoresponders();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not create autoresponder");
    } finally {
      setArBusy(false);
    }
  }

  async function onDeleteAutoresponder(id: string) {
    try {
      await apiDelete(`/api/v1/email/autoresponders/${id}`);
      await refreshAutoresponders();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not delete autoresponder");
    }
  }

  const [filters, setFilters] = useState<Filter[]>([]);
  const [flt, setFlt] = useState({
    address: "",
    name: "",
    field: "subject",
    op: "contains",
    value: "",
    action: "fileinto",
    action_arg: "",
  });
  const [fltBusy, setFltBusy] = useState(false);

  async function refreshFilters() {
    try {
      const { filters } = await apiGet<{ filters: Filter[] }>("/api/v1/email/filters");
      setFilters(filters);
    } catch {
      /* keep the section empty if the backend is unreachable */
    }
  }

  async function onCreateFilter(e: FormEvent) {
    e.preventDefault();
    setFltBusy(true);
    setError(null);
    try {
      await apiPost("/api/v1/email/filters", { ...flt, address: flt.address.trim(), name: flt.name.trim() });
      setFlt({ address: "", name: "", field: "subject", op: "contains", value: "", action: "fileinto", action_arg: "" });
      await refreshFilters();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not create filter");
    } finally {
      setFltBusy(false);
    }
  }

  async function onDeleteFilter(id: string) {
    try {
      await apiDelete(`/api/v1/email/filters/${id}`);
      await refreshFilters();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not delete filter");
    }
  }

  const filterActionLabel: Record<string, string> = {
    fileinto: "File into folder",
    discard: "Discard",
    redirect: "Forward to",
    keep: "Keep (no-op)",
  };

  const [spam, setSpam] = useState<SpamSettings>({
    reject_score: 15,
    add_header_score: 6,
    greylisting: true,
  });
  const [spamRules, setSpamRules] = useState<SpamRule[]>([]);
  const [spamRule, setSpamRule] = useState({ kind: "deny", value: "" });
  const [spamBusy, setSpamBusy] = useState(false);

  async function refreshSpam() {
    try {
      const r = await apiGet<{ settings: SpamSettings; rules: SpamRule[] }>("/api/v1/email/spam");
      if (r.settings) setSpam(r.settings);
      setSpamRules(r.rules ?? []);
    } catch {
      /* keep defaults if the backend is unreachable */
    }
  }

  async function onSaveSpam(e: FormEvent) {
    e.preventDefault();
    setSpamBusy(true);
    setError(null);
    try {
      await apiPut("/api/v1/email/spam/settings", spam);
      await refreshSpam();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save spam settings");
    } finally {
      setSpamBusy(false);
    }
  }

  async function onAddSpamRule(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await apiPost("/api/v1/email/spam/rules", { kind: spamRule.kind, value: spamRule.value.trim() });
      setSpamRule({ kind: spamRule.kind, value: "" });
      await refreshSpam();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not add rule");
    }
  }

  async function onDeleteSpamRule(id: string) {
    try {
      await apiDelete(`/api/v1/email/spam/rules/${id}`);
      await refreshSpam();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not delete rule");
    }
  }

  const [lists, setLists] = useState<MailList[]>([]);
  const [listAddress, setListAddress] = useState("");
  const [listBusy, setListBusy] = useState(false);
  const [memberInputs, setMemberInputs] = useState<Record<string, string>>({});

  async function refreshLists() {
    try {
      const { lists } = await apiGet<{ lists: MailList[] }>("/api/v1/email/lists");
      setLists(lists);
    } catch {
      /* keep the section empty if the backend is unreachable */
    }
  }

  async function onCreateList(e: FormEvent) {
    e.preventDefault();
    setListBusy(true);
    setError(null);
    try {
      await apiPost("/api/v1/email/lists", { address: listAddress.trim() });
      setListAddress("");
      await refreshLists();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not create list");
    } finally {
      setListBusy(false);
    }
  }

  async function onDeleteList(id: string) {
    try {
      await apiDelete(`/api/v1/email/lists/${id}`);
      await refreshLists();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not delete list");
    }
  }

  async function onAddMember(listId: string) {
    const email = (memberInputs[listId] || "").trim();
    if (!email) return;
    try {
      await apiPost(`/api/v1/email/lists/${listId}/members`, { email });
      setMemberInputs({ ...memberInputs, [listId]: "" });
      await refreshLists();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not add member");
    }
  }

  async function onDeleteMember(memberId: string) {
    try {
      await apiDelete(`/api/v1/email/lists/members/${memberId}`);
      await refreshLists();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not remove member");
    }
  }

  const [caldav, setCaldav] = useState<CaldavAccount[]>([]);
  const [caldavForm, setCaldavForm] = useState({ username: "", password: "" });
  const [caldavBusy, setCaldavBusy] = useState(false);
  const [caldavNotice, setCaldavNotice] = useState<string | null>(null);

  async function refreshCaldav() {
    try {
      const { accounts } = await apiGet<{ accounts: CaldavAccount[] }>(
        "/api/v1/email/caldav/accounts",
      );
      setCaldav(accounts);
    } catch {
      /* keep the section empty if the backend is unreachable */
    }
  }

  async function onEnsureCaldav() {
    setError(null);
    setCaldavNotice(null);
    try {
      await apiPost("/api/v1/email/caldav/ensure", {});
      setCaldavNotice("Radicale server launch dispatched to the node.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not start the server");
    }
  }

  async function onCreateCaldav(e: FormEvent) {
    e.preventDefault();
    setCaldavBusy(true);
    setError(null);
    try {
      await apiPost("/api/v1/email/caldav/accounts", {
        username: caldavForm.username.trim(),
        password: caldavForm.password,
      });
      setCaldavForm({ username: "", password: "" });
      await refreshCaldav();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not create account");
    } finally {
      setCaldavBusy(false);
    }
  }

  async function onDeleteCaldav(id: string) {
    try {
      await apiDelete(`/api/v1/email/caldav/accounts/${id}`);
      await refreshCaldav();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not delete account");
    }
  }

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
    refreshForwarders();
    refreshAutoresponders();
    refreshFilters();
    refreshSpam();
    refreshLists();
    refreshCaldav();
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
      <PageHeader
        title="Mailboxes"
        description="IMAP/SMTP mailboxes with quotas, SPF/DKIM signing and spam filtering."
      />

      {error && <p className="text-sm text-red-600">{error}</p>}
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
                <span className="text-emerald-600">DKIM</span> {dkim.record.name}{" "}
                <span className="text-muted-foreground">TTL {3600}</span>
                <div className="break-all">{dkim.record.content || <em>see node logs</em>}</div>
              </div>
              <div>
                <span className="text-emerald-600">SPF </span> {dkim.spf.name} ·{" "}
                {dkim.spf.content}
              </div>
              <div>
                <span className="text-emerald-600">DMARC</span> {dkim.dmarc.name} ·{" "}
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

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Forwarders &amp; aliases ({forwarders.length})</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Route mail from an address to one or more destinations. Use{" "}
            <code className="rounded bg-muted px-1 py-0.5 text-xs">@domain.com</code> as the source
            for a catch-all that captures every unmatched recipient.
          </p>
          <form onSubmit={onCreateForwarder} className="grid gap-4 sm:grid-cols-5 sm:items-end">
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="fwd-source">Source</Label>
              <Input
                id="fwd-source"
                value={fwdSource}
                onChange={(e) => setFwdSource(e.target.value)}
                placeholder="sales@acme.com or @acme.com"
                required
              />
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="fwd-dests">Destinations (comma-separated)</Label>
              <Input
                id="fwd-dests"
                value={fwdDests}
                onChange={(e) => setFwdDests(e.target.value)}
                placeholder="a@acme.com, b@acme.com"
                required
              />
            </div>
            <Button type="submit" disabled={fwdBusy}>
              {fwdBusy ? "Adding…" : "Add forwarder"}
            </Button>
          </form>

          {forwarders.length === 0 ? (
            <p className="text-sm text-muted-foreground">No forwarders yet.</p>
          ) : (
            <ul className="divide-y divide-border/60 rounded-md border border-border/60">
              {forwarders.map((f) => (
                <li key={f.id} className="flex items-center gap-3 px-4 py-2 text-sm">
                  <span className="font-mono">{f.source}</span>
                  {f.is_catchall && (
                    <span className="rounded bg-primary/15 px-1.5 py-0.5 text-[11px] text-primary">
                      catch-all
                    </span>
                  )}
                  <span className="text-muted-foreground">→</span>
                  <span className="font-mono text-xs text-muted-foreground">
                    {f.destinations.join(", ")}
                  </span>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="ml-auto h-7 w-7"
                    onClick={() => onDeleteForwarder(f.id)}
                    aria-label="Delete forwarder"
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Autoresponders ({autoresponders.length})</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Vacation auto-replies. Optionally bound to a date range; the same sender is answered at
            most once per interval.
          </p>
          <form onSubmit={onCreateAutoresponder} className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="ar-address">Address</Label>
                <Input
                  id="ar-address"
                  value={ar.address}
                  onChange={(e) => setAr({ ...ar, address: e.target.value })}
                  placeholder="vip@acme.com"
                  required
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="ar-subject">Subject</Label>
                <Input
                  id="ar-subject"
                  value={ar.subject}
                  onChange={(e) => setAr({ ...ar, subject: e.target.value })}
                  placeholder="Out of office"
                  required
                />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ar-body">Message</Label>
              <Textarea
                id="ar-body"
                value={ar.body}
                onChange={(e) => setAr({ ...ar, body: e.target.value })}
                placeholder="I'm away until Monday and will reply on my return."
                required
              />
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="space-y-1.5">
                <Label htmlFor="ar-interval">Reply interval (days)</Label>
                <Input
                  id="ar-interval"
                  type="number"
                  min={1}
                  max={30}
                  value={ar.interval_days}
                  onChange={(e) => setAr({ ...ar, interval_days: e.target.value })}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="ar-start">Start (optional)</Label>
                <Input
                  id="ar-start"
                  type="date"
                  value={ar.start_date}
                  onChange={(e) => setAr({ ...ar, start_date: e.target.value })}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="ar-end">End (optional)</Label>
                <Input
                  id="ar-end"
                  type="date"
                  value={ar.end_date}
                  onChange={(e) => setAr({ ...ar, end_date: e.target.value })}
                />
              </div>
            </div>
            <Button type="submit" disabled={arBusy}>
              {arBusy ? "Saving…" : "Add autoresponder"}
            </Button>
          </form>

          {autoresponders.length === 0 ? (
            <p className="text-sm text-muted-foreground">No autoresponders yet.</p>
          ) : (
            <ul className="divide-y divide-border/60 rounded-md border border-border/60">
              {autoresponders.map((a) => (
                <li key={a.id} className="flex items-start gap-3 px-4 py-2 text-sm">
                  <div className="min-w-0">
                    <div className="font-mono">{a.address}</div>
                    <div className="text-xs text-muted-foreground">
                      “{a.subject}” · every {a.interval_days}d
                      {a.start_date && ` · ${a.start_date} → ${a.end_date || "…"}`}
                    </div>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="ml-auto h-7 w-7"
                    onClick={() => onDeleteAutoresponder(a.id)}
                    aria-label="Delete autoresponder"
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Filters ({filters.length})</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Server-side rules (Sieve): match a header on an incoming message for a mailbox, then
            file it into a folder, forward, or discard it.
          </p>
          <form onSubmit={onCreateFilter} className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="flt-address">Mailbox</Label>
                <Input
                  id="flt-address"
                  value={flt.address}
                  onChange={(e) => setFlt({ ...flt, address: e.target.value })}
                  placeholder="info@acme.com"
                  required
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="flt-name">Rule name</Label>
                <Input
                  id="flt-name"
                  value={flt.name}
                  onChange={(e) => setFlt({ ...flt, name: e.target.value })}
                  placeholder="Route newsletters"
                  required
                />
              </div>
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="space-y-1.5">
                <Label htmlFor="flt-field">If header</Label>
                <select
                  id="flt-field"
                  className={selectCls}
                  value={flt.field}
                  onChange={(e) => setFlt({ ...flt, field: e.target.value })}
                >
                  <option value="from">From</option>
                  <option value="to">To</option>
                  <option value="subject">Subject</option>
                  <option value="cc">Cc</option>
                </select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="flt-op">Operator</Label>
                <select
                  id="flt-op"
                  className={selectCls}
                  value={flt.op}
                  onChange={(e) => setFlt({ ...flt, op: e.target.value })}
                >
                  <option value="contains">contains</option>
                  <option value="is">is exactly</option>
                  <option value="matches">matches (wildcards)</option>
                </select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="flt-value">Value</Label>
                <Input
                  id="flt-value"
                  value={flt.value}
                  onChange={(e) => setFlt({ ...flt, value: e.target.value })}
                  placeholder="[newsletter]"
                  required
                />
              </div>
            </div>
            <div className="grid gap-3 sm:grid-cols-3 sm:items-end">
              <div className="space-y-1.5">
                <Label htmlFor="flt-action">Then</Label>
                <select
                  id="flt-action"
                  className={selectCls}
                  value={flt.action}
                  onChange={(e) => setFlt({ ...flt, action: e.target.value })}
                >
                  <option value="fileinto">File into folder</option>
                  <option value="redirect">Forward to</option>
                  <option value="discard">Discard</option>
                  <option value="keep">Keep (no-op)</option>
                </select>
              </div>
              {(flt.action === "fileinto" || flt.action === "redirect") && (
                <div className="space-y-1.5">
                  <Label htmlFor="flt-arg">
                    {flt.action === "fileinto" ? "Folder" : "Forward to"}
                  </Label>
                  <Input
                    id="flt-arg"
                    value={flt.action_arg}
                    onChange={(e) => setFlt({ ...flt, action_arg: e.target.value })}
                    placeholder={flt.action === "fileinto" ? "Newsletters" : "team@acme.com"}
                    required
                  />
                </div>
              )}
              <Button type="submit" disabled={fltBusy}>
                {fltBusy ? "Saving…" : "Add filter"}
              </Button>
            </div>
          </form>

          {filters.length === 0 ? (
            <p className="text-sm text-muted-foreground">No filters yet.</p>
          ) : (
            <ul className="divide-y divide-border/60 rounded-md border border-border/60">
              {filters.map((f) => (
                <li key={f.id} className="flex items-start gap-3 px-4 py-2 text-sm">
                  <div className="min-w-0">
                    <div className="font-medium">{f.name}</div>
                    <div className="text-xs text-muted-foreground">
                      <span className="font-mono">{f.address}</span> · if {f.field} {f.op} “{f.value}
                      ” → {filterActionLabel[f.action] ?? f.action}
                      {f.action_arg && ` ${f.action_arg}`}
                    </div>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="ml-auto h-7 w-7"
                    onClick={() => onDeleteFilter(f.id)}
                    aria-label="Delete filter"
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Spam filter (Rspamd)</CardTitle>
        </CardHeader>
        <CardContent className="space-y-5">
          <p className="text-sm text-muted-foreground">
            Tune the spam scoring thresholds and maintain sender allow/deny lists. Higher score =
            more aggressive.
          </p>
          <form onSubmit={onSaveSpam} className="grid gap-3 sm:grid-cols-4 sm:items-end">
            <div className="space-y-1.5">
              <Label htmlFor="sp-reject">Reject at score</Label>
              <Input
                id="sp-reject"
                type="number"
                min={1}
                max={100}
                value={spam.reject_score}
                onChange={(e) => setSpam({ ...spam, reject_score: Number(e.target.value) })}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="sp-header">Flag at score</Label>
              <Input
                id="sp-header"
                type="number"
                min={1}
                max={100}
                value={spam.add_header_score}
                onChange={(e) => setSpam({ ...spam, add_header_score: Number(e.target.value) })}
              />
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={spam.greylisting}
                onChange={(e) => setSpam({ ...spam, greylisting: e.target.checked })}
                className="h-4 w-4 rounded border-border"
              />
              Greylisting
            </label>
            <Button type="submit" disabled={spamBusy}>
              {spamBusy ? "Saving…" : "Save thresholds"}
            </Button>
          </form>

          <form onSubmit={onAddSpamRule} className="grid gap-3 sm:grid-cols-4 sm:items-end">
            <div className="space-y-1.5">
              <Label htmlFor="sp-kind">List</Label>
              <select
                id="sp-kind"
                className={selectCls}
                value={spamRule.kind}
                onChange={(e) => setSpamRule({ ...spamRule, kind: e.target.value })}
              >
                <option value="allow">Allow (whitelist)</option>
                <option value="deny">Deny (blacklist)</option>
              </select>
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="sp-value">Sender or domain</Label>
              <Input
                id="sp-value"
                value={spamRule.value}
                onChange={(e) => setSpamRule({ ...spamRule, value: e.target.value })}
                placeholder="newsletter@acme.com or spammy.example"
                required
              />
            </div>
            <Button type="submit" variant="outline">
              Add
            </Button>
          </form>

          {spamRules.length > 0 && (
            <ul className="divide-y divide-border/60 rounded-md border border-border/60">
              {spamRules.map((rl) => (
                <li key={rl.id} className="flex items-center gap-3 px-4 py-2 text-sm">
                  <span
                    className={`rounded px-1.5 py-0.5 text-[11px] ${
                      rl.kind === "allow"
                        ? "bg-emerald-500/15 text-emerald-600"
                        : "bg-red-500/15 text-red-600"
                    }`}
                  >
                    {rl.kind}
                  </span>
                  <span className="font-mono">{rl.value}</span>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="ml-auto h-7 w-7"
                    onClick={() => onDeleteSpamRule(rl.id)}
                    aria-label="Delete spam rule"
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Mailing lists ({lists.length})</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            A list address fans out to its members — mail sent to it is delivered to everyone
            subscribed.
          </p>
          <form onSubmit={onCreateList} className="flex flex-wrap items-end gap-3">
            <div className="grow space-y-1.5">
              <Label htmlFor="list-address">List address</Label>
              <Input
                id="list-address"
                value={listAddress}
                onChange={(e) => setListAddress(e.target.value)}
                placeholder="team@acme.com"
                required
              />
            </div>
            <Button type="submit" disabled={listBusy}>
              {listBusy ? "Creating…" : "Create list"}
            </Button>
          </form>

          {lists.length > 0 && (
            <div className="space-y-3">
              {lists.map((l) => (
                <div key={l.id} className="rounded-md border border-border/60 p-3">
                  <div className="flex items-center gap-3">
                    <span className="font-mono text-sm">{l.address}</span>
                    <span className="text-xs text-muted-foreground">
                      {l.member_count} member{l.member_count === 1 ? "" : "s"}
                    </span>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="ml-auto h-7 w-7"
                      onClick={() => onDeleteList(l.id)}
                      aria-label="Delete list"
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                  {l.members.length > 0 && (
                    <ul className="mt-2 flex flex-wrap gap-1.5">
                      {l.members.map((m) => (
                        <li
                          key={m.id}
                          className="flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-xs"
                        >
                          <span className="font-mono">{m.email}</span>
                          <button
                            type="button"
                            onClick={() => onDeleteMember(m.id)}
                            aria-label="Remove member"
                            className="text-muted-foreground hover:text-red-600"
                          >
                            ×
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                  <div className="mt-2 flex items-end gap-2">
                    <Input
                      value={memberInputs[l.id] ?? ""}
                      onChange={(e) => setMemberInputs({ ...memberInputs, [l.id]: e.target.value })}
                      placeholder="member@acme.com"
                      className="h-8"
                    />
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => onAddMember(l.id)}
                    >
                      Add
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="text-base">Calendars &amp; Contacts ({caldav.length})</CardTitle>
          <Button variant="outline" size="sm" onClick={onEnsureCaldav}>
            Start server
          </Button>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            CalDAV/CardDAV accounts (Radicale). Point a calendar/contacts client at{" "}
            <code className="rounded bg-muted px-1 py-0.5 text-xs">
              https://&lt;node&gt;:5232/&lt;user&gt;/
            </code>{" "}
            with the account credentials.
          </p>
          {caldavNotice && <p className="text-sm text-emerald-600">{caldavNotice}</p>}
          <form onSubmit={onCreateCaldav} className="grid gap-3 sm:grid-cols-3 sm:items-end">
            <div className="space-y-1.5">
              <Label htmlFor="cd-user">Username</Label>
              <Input
                id="cd-user"
                value={caldavForm.username}
                onChange={(e) => setCaldavForm({ ...caldavForm, username: e.target.value })}
                placeholder="alice"
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="cd-pass">Password</Label>
              <Input
                id="cd-pass"
                type="password"
                value={caldavForm.password}
                onChange={(e) => setCaldavForm({ ...caldavForm, password: e.target.value })}
                placeholder="min 6 chars"
                required
              />
            </div>
            <Button type="submit" disabled={caldavBusy}>
              {caldavBusy ? "Creating…" : "Create account"}
            </Button>
          </form>
          {caldav.length > 0 && (
            <ul className="divide-y divide-border/60 rounded-md border border-border/60">
              {caldav.map((a) => (
                <li key={a.id} className="flex items-center gap-3 px-4 py-2 text-sm">
                  <span className="font-mono">{a.username}</span>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="ml-auto h-7 w-7"
                    onClick={() => onDeleteCaldav(a.id)}
                    aria-label="Delete CalDAV account"
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
