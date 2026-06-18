"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Copy, LogIn, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { apiGet, apiPost } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { Feature, ProGate } from "@/lib/license";
import { PageHeader } from "@/components/page-header";

interface Account {
  id: string;
  name: string;
  slug: string;
  status: "active" | "suspended" | "deleted";
  plan_code: string | null;
  sites: number;
  created_at: string;
  owner_user_id?: string | null;
  owner_email?: string | null;
}

interface Created {
  account: Account;
  owner_email: string;
  temp_password: string;
}

const statusBadge: Record<string, string> = {
  active: "bg-emerald-500/15 text-emerald-600",
  suspended: "bg-amber-500/15 text-amber-600",
  deleted: "bg-muted text-muted-foreground",
};

export default function ResellerPage() {
  const { impersonate } = useAuth();
  const router = useRouter();
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [plan, setPlan] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<Created | null>(null);

  async function load() {
    try {
      const { accounts } = await apiGet<{ accounts: Account[] }>("/api/v1/reseller/accounts");
      setAccounts(accounts ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    }
  }
  useEffect(() => {
    load();
  }, []);

  async function create(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await apiPost<Created>("/api/v1/reseller/accounts", {
        name,
        admin_email: email,
        plan_code: plan || undefined,
      });
      setCreated(res);
      setName("");
      setEmail("");
      setPlan("");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create sub-account");
    } finally {
      setBusy(false);
    }
  }

  async function setStatus(id: string, status: "active" | "suspended") {
    setError(null);
    try {
      await apiPost(`/api/v1/reseller/accounts/${id}/status`, { status });
      setAccounts((prev) => prev.map((a) => (a.id === id ? { ...a, status } : a)));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to update status");
    }
  }

  // Log in as the sub-account owner for support, then land on their dashboard.
  async function onImpersonate(a: Account) {
    if (!a.owner_user_id) return;
    setError(null);
    try {
      await impersonate(a.owner_user_id);
      router.push("/dashboard");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not start impersonation");
    }
  }

  return (
    <ProGate feature={Feature.Reseller}>
    <div className="space-y-6">
      <PageHeader title={"Reseller"} description={"Create and manage customer sub-accounts under your organization."} />

      {error && <p className="text-sm text-red-600">{error}</p>}

      {created && (
        <div className="rounded-md border border-emerald-500/40 bg-emerald-500/5 px-4 py-3 text-sm">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="font-medium text-emerald-600">
                Sub-account “{created.account.name}” created.
              </p>
              <p className="mt-1 text-muted-foreground">
                Owner <span className="font-mono">{created.owner_email}</span> — temporary password
                (shown once):
              </p>
              <code className="mt-1 inline-block rounded bg-background px-2 py-1 font-mono text-foreground">
                {created.temp_password}
              </code>
            </div>
            <div className="flex items-center gap-1">
              <Button
                variant="ghost"
                size="icon"
                onClick={() => navigator.clipboard?.writeText(created.temp_password)}
                aria-label="Copy password"
              >
                <Copy className="h-4 w-4" />
              </Button>
              <Button variant="ghost" size="icon" onClick={() => setCreated(null)} aria-label="Dismiss">
                <X className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">New sub-account</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={create} className="flex flex-wrap items-end gap-3">
            <div className="grow space-y-1">
              <Label htmlFor="name">Company name</Label>
              <Input id="name" value={name} onChange={(e) => setName(e.target.value)} required />
            </div>
            <div className="grow space-y-1">
              <Label htmlFor="email">Admin email</Label>
              <Input
                id="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="plan">Plan code</Label>
              <Input
                id="plan"
                placeholder="optional"
                value={plan}
                onChange={(e) => setPlan(e.target.value)}
              />
            </div>
            <Button type="submit" disabled={busy}>
              Create
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Sub-accounts ({accounts.length})</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <table className="w-full text-sm">
            <thead className="border-b border-border text-left text-muted-foreground">
              <tr>
                <th className="px-6 py-3 font-medium">Name</th>
                <th className="px-6 py-3 font-medium">Plan</th>
                <th className="px-6 py-3 font-medium">Sites</th>
                <th className="px-6 py-3 font-medium">Status</th>
                <th className="px-6 py-3" />
              </tr>
            </thead>
            <tbody>
              {accounts.map((a) => (
                <tr key={a.id} className="border-b border-border/60 last:border-0">
                  <td className="px-6 py-3">
                    <div className="font-medium">{a.name}</div>
                    <div className="font-mono text-xs text-muted-foreground">{a.slug}</div>
                  </td>
                  <td className="px-6 py-3 text-muted-foreground">{a.plan_code ?? "—"}</td>
                  <td className="px-6 py-3 text-muted-foreground">{a.sites}</td>
                  <td className="px-6 py-3">
                    <span
                      className={cn(
                        "rounded-full px-2 py-0.5 text-xs font-medium capitalize",
                        statusBadge[a.status],
                      )}
                    >
                      {a.status}
                    </span>
                  </td>
                  <td className="px-6 py-3 text-right">
                    <div className="flex items-center justify-end gap-1">
                      {a.owner_user_id && a.status === "active" && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => onImpersonate(a)}
                          title={a.owner_email ? `Log in as ${a.owner_email}` : "Log in as owner"}
                        >
                          <LogIn className="h-4 w-4" />
                          Impersonate
                        </Button>
                      )}
                      {a.status === "active" ? (
                        <Button variant="ghost" size="sm" onClick={() => setStatus(a.id, "suspended")}>
                          Suspend
                        </Button>
                      ) : (
                        <Button variant="ghost" size="sm" onClick={() => setStatus(a.id, "active")}>
                          Activate
                        </Button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
              {accounts.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-6 py-8 text-center text-muted-foreground">
                    No sub-accounts yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
    </ProGate>
  );
}
