"use client";

import { useEffect, useState } from "react";
import { Receipt, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { apiGet, apiPost } from "@/lib/api";

interface Billing {
  plan: string;
  limits: Record<string, number>;
  usage: Record<string, number>;
}
interface Line {
  description: string;
  quantity: number;
  unit_cents: number;
  amount_cents: number;
}
interface Invoice {
  id: string;
  number: string;
  status: "draft" | "open" | "paid" | "void";
  currency: string;
  period_start: string;
  period_end: string;
  subtotal_cents: number;
  total_cents: number;
  issued_at: string;
  due_at: string | null;
  paid_at: string | null;
  lines?: Line[];
}

const sym: Record<string, string> = { EUR: "€", USD: "$", GBP: "£" };
const money = (cents: number, cur: string) => `${sym[cur] ?? cur + " "}${(cents / 100).toFixed(2)}`;

const statusBadge: Record<Invoice["status"], string> = {
  paid: "bg-emerald-500/15 text-emerald-400",
  open: "bg-amber-500/15 text-amber-400",
  draft: "bg-muted text-muted-foreground",
  void: "bg-muted text-muted-foreground",
};

export default function BillingPage() {
  const [billing, setBilling] = useState<Billing | null>(null);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [detail, setDetail] = useState<Invoice | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    try {
      const [b, inv] = await Promise.all([
        apiGet<Billing>("/api/v1/billing"),
        apiGet<{ invoices: Invoice[] }>("/api/v1/billing/invoices"),
      ]);
      setBilling(b);
      setInvoices(inv.invoices ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load billing");
    }
  }
  useEffect(() => {
    load();
  }, []);

  async function generate() {
    setBusy(true);
    setError(null);
    try {
      await apiPost("/api/v1/billing/invoices");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to generate invoice");
    } finally {
      setBusy(false);
    }
  }
  async function view(id: string) {
    try {
      const { invoice } = await apiGet<{ invoice: Invoice }>(`/api/v1/billing/invoices/${id}`);
      setDetail(invoice);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load invoice");
    }
  }
  async function pay(id: string) {
    setBusy(true);
    setError(null);
    try {
      await apiPost(`/api/v1/billing/invoices/${id}/pay`);
      setDetail(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Payment failed");
    } finally {
      setBusy(false);
    }
  }

  const cur = invoices[0]?.currency ?? "EUR";
  const limits = billing?.limits ?? {};

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Billing</h1>
          <p className="text-sm text-muted-foreground">
            Plan <span className="font-medium capitalize text-foreground">{billing?.plan ?? "—"}</span>, usage and invoices.
          </p>
        </div>
        <Button size="sm" disabled={busy} onClick={generate}>
          <Receipt className="h-4 w-4" />
          Generate invoice
        </Button>
      </header>

      {error && <p className="text-sm text-red-400">{error}</p>}

      {Object.keys(limits).length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Plan usage</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {Object.entries(limits).map(([key, limit]) => {
              const res = key.replace(/^max_/, "");
              const used = billing?.usage?.[res] ?? 0;
              const pct = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;
              return (
                <div key={key}>
                  <div className="flex items-center justify-between text-sm">
                    <span className="capitalize">{res}</span>
                    <span className="text-muted-foreground">
                      {used} / {limit > 0 ? limit : "∞"}
                    </span>
                  </div>
                  <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-muted">
                    <div
                      className={cn("h-full rounded-full", pct >= 90 ? "bg-red-400" : "bg-primary")}
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                </div>
              );
            })}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Invoices ({invoices.length})</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <table className="w-full text-sm">
            <thead className="border-b border-border text-left text-muted-foreground">
              <tr>
                <th className="px-6 py-3 font-medium">Number</th>
                <th className="px-6 py-3 font-medium">Period</th>
                <th className="px-6 py-3 font-medium">Total</th>
                <th className="px-6 py-3 font-medium">Status</th>
                <th className="px-6 py-3" />
              </tr>
            </thead>
            <tbody>
              {invoices.map((inv) => (
                <tr key={inv.id} className="border-b border-border/60 last:border-0">
                  <td className="px-6 py-3 font-mono text-xs">{inv.number}</td>
                  <td className="px-6 py-3 text-muted-foreground">
                    {new Date(inv.period_start).toLocaleDateString()} –{" "}
                    {new Date(inv.period_end).toLocaleDateString()}
                  </td>
                  <td className="px-6 py-3">{money(inv.total_cents, inv.currency)}</td>
                  <td className="px-6 py-3">
                    <span
                      className={cn(
                        "rounded-full px-2 py-0.5 text-xs font-medium capitalize",
                        statusBadge[inv.status],
                      )}
                    >
                      {inv.status}
                    </span>
                  </td>
                  <td className="px-6 py-3 text-right">
                    <Button variant="ghost" size="sm" onClick={() => view(inv.id)}>
                      View
                    </Button>
                    {inv.status === "open" && (
                      <Button size="sm" disabled={busy} onClick={() => pay(inv.id)}>
                        Pay
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
              {invoices.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-6 py-8 text-center text-muted-foreground">
                    No invoices yet. Generate one to bill the current period.
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
            className="w-full max-w-lg rounded-lg border border-border bg-background shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-border px-5 py-3">
              <div>
                <p className="font-mono text-sm">{detail.number}</p>
                <p className="text-xs text-muted-foreground">
                  {new Date(detail.period_start).toLocaleDateString()} –{" "}
                  {new Date(detail.period_end).toLocaleDateString()}
                </p>
              </div>
              <Button variant="ghost" size="icon" onClick={() => setDetail(null)}>
                <X className="h-4 w-4" />
              </Button>
            </div>
            <div className="px-5 py-4">
              <table className="w-full text-sm">
                <tbody>
                  {detail.lines?.map((l, i) => (
                    <tr key={i} className="border-b border-border/40 last:border-0">
                      <td className="py-2">
                        {l.description}
                        {l.quantity > 1 ? ` × ${l.quantity}` : ""}
                      </td>
                      <td className="py-2 text-right">{money(l.amount_cents, detail.currency)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="mt-3 flex items-center justify-between border-t border-border pt-3 font-medium">
                <span>Total</span>
                <span>{money(detail.total_cents, detail.currency)}</span>
              </div>
            </div>
            <div className="flex items-center justify-end gap-2 border-t border-border px-5 py-3">
              <span
                className={cn(
                  "mr-auto rounded-full px-2 py-0.5 text-xs font-medium capitalize",
                  statusBadge[detail.status],
                )}
              >
                {detail.status}
              </span>
              {detail.status === "open" && (
                <Button size="sm" disabled={busy} onClick={() => pay(detail.id)}>
                  Pay {money(detail.total_cents, detail.currency)}
                </Button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
