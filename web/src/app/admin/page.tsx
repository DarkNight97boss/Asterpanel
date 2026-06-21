"use client";

import { useEffect, useState } from "react";
import { Plug, Plus, CircleCheck } from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { apiGet } from "@/lib/api";

interface Dashboard {
  income_cents: number;
  active_services: number;
  open_tickets: number;
  overdue_invoices: number;
  recent_invoices: { client: string; amount_cents: number; status: string }[];
  backends: { name: string; connected: boolean; accounts?: number }[];
}

const euro = (cents: number) => `€${(cents / 100).toLocaleString("it-IT")}`;

const invoiceBadge: Record<string, string> = {
  paid: "bg-emerald-500/15 text-emerald-600",
  overdue: "bg-red-500/15 text-red-600",
  open: "bg-amber-500/15 text-amber-600",
};
const invoiceLabel: Record<string, string> = { paid: "Pagata", overdue: "Scaduta", open: "Aperta" };

export default function AdminDashboard() {
  const [d, setD] = useState<Dashboard | null>(null);

  useEffect(() => {
    apiGet<Dashboard>("/api/billing/dashboard")
      .then(setD)
      .catch(() => setD(null));
  }, []);

  const kpis = [
    { label: "Incasso · mese", value: d ? euro(d.income_cents) : "—" },
    { label: "Servizi attivi", value: d ? String(d.active_services) : "—" },
    { label: "Ticket aperti", value: d ? String(d.open_tickets) : "—" },
    { label: "Fatture scadute", value: d ? String(d.overdue_invoices) : "—", danger: true },
  ];

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-medium">Dashboard</h1>
          <p className="text-sm text-muted-foreground">Panoramica · giugno 2026</p>
        </div>
        <div className="flex items-center gap-2">
          <span className="inline-flex items-center gap-1.5 rounded-md bg-emerald-500/15 px-2.5 py-1 text-xs font-medium text-emerald-600">
            <Plug className="h-3.5 w-3.5" /> AsterPanel connesso
          </span>
          <Button size="sm">
            <Plus className="h-4 w-4" /> Nuovo ordine
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {kpis.map((k) => (
          <div key={k.label} className="rounded-lg bg-muted/40 p-4">
            <div className="text-xs text-muted-foreground">{k.label}</div>
            <div className={cn("mt-1 text-2xl font-medium", k.danger && "text-red-600")}>{k.value}</div>
          </div>
        ))}
      </div>

      <div className="grid gap-3 lg:grid-cols-[1.55fr_1fr]">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Fatture recenti</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2.5">
            {(d?.recent_invoices ?? []).map((inv, i) => (
              <div key={i} className="flex items-center gap-3 text-sm">
                <span className="min-w-0 flex-1 truncate">{inv.client}</span>
                <span className="text-xs text-muted-foreground">{euro(inv.amount_cents)}</span>
                <span className={cn("rounded-md px-2 py-0.5 text-[11px] font-medium", invoiceBadge[inv.status])}>
                  {invoiceLabel[inv.status] ?? inv.status}
                </span>
              </div>
            ))}
            {!d && <div className="text-sm text-muted-foreground">Caricamento…</div>}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Backend hosting</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2.5 text-sm">
            {(d?.backends ?? []).map((b) => (
              <div key={b.name} className={cn("flex items-center gap-2", !b.connected && "text-muted-foreground/60")}>
                <span
                  className={cn(
                    "h-2 w-2 rounded-full",
                    b.connected ? "bg-emerald-500" : "bg-muted-foreground/40",
                  )}
                />
                {b.name}
                <span className="ml-auto text-xs text-muted-foreground">
                  {b.connected ? `${b.accounts} account` : "modulo"}
                </span>
              </div>
            ))}
            <div className="mt-3 space-y-1.5 border-t border-border pt-3 text-xs text-muted-foreground">
              <div className="flex items-center gap-1.5">
                <CircleCheck className="h-3.5 w-3.5 text-emerald-500" /> Fatturazione · oggi 03:00
              </div>
              <div className="flex items-center gap-1.5">
                <CircleCheck className="h-3.5 w-3.5 text-emerald-500" /> Dunning · oggi 03:05
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
