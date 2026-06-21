"use client";

import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { apiGet, apiPost } from "@/lib/api";

interface Invoice {
  id: string;
  client_id: string;
  number: string;
  status: string;
  total_cents: number;
  due_at: string;
}
interface Client {
  id: string;
  name: string;
}

const euro = (cents: number) => `€${(cents / 100).toLocaleString("it-IT")}`;
const isOverdue = (inv: Invoice) =>
  inv.status === "open" && new Date(inv.due_at).getTime() < Date.now();

const badge: Record<string, string> = {
  paid: "bg-emerald-500/15 text-emerald-600",
  open: "bg-amber-500/15 text-amber-600",
  void: "bg-muted text-muted-foreground",
  overdue: "bg-red-500/15 text-red-600",
};
const label: Record<string, string> = { paid: "Pagata", open: "Aperta", void: "Annullata", overdue: "Scaduta" };

export default function InvoicesPage() {
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [clients, setClients] = useState<Client[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function runDunning() {
    setError(null);
    setNotice(null);
    try {
      const { suspended } = await apiPost<{ suspended: number }>("/api/billing/dunning", {});
      setNotice(
        suspended > 0
          ? `Dunning: sospesi ${suspended} ${suspended === 1 ? "servizio" : "servizi"} per insoluto.`
          : "Dunning: nessun cliente con fatture scadute.",
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Dunning non riuscito");
    }
  }

  async function runBilling() {
    setError(null);
    setNotice(null);
    try {
      const { generated, skipped } = await apiPost<{ generated: number; skipped: number }>(
        "/api/billing/run",
        {},
      );
      setNotice(
        `Fatturazione: ${generated} ${generated === 1 ? "fattura generata" : "fatture generate"}` +
          (skipped ? `, ${skipped} già fatturate questo mese.` : "."),
      );
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Fatturazione non riuscita");
    }
  }

  async function load() {
    try {
      const [inv, cli] = await Promise.all([
        apiGet<{ invoices: Invoice[] }>("/api/billing/invoices"),
        apiGet<{ clients: Client[] }>("/api/billing/clients"),
      ]);
      setInvoices(inv.invoices ?? []);
      setClients(cli.clients ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Errore di caricamento");
    }
  }
  useEffect(() => {
    load();
  }, []);

  const clientName = (id: string) => clients.find((c) => c.id === id)?.name ?? id;

  async function pay(id: string) {
    setError(null);
    try {
      await apiPost(`/api/billing/invoices/${id}/pay`, {});
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Pagamento non riuscito");
    }
  }

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-medium">Fatture</h1>
        <p className="text-sm text-muted-foreground">
          Saldate tramite il gateway astratto — manuale (offline) di default, nessuno Stripe richiesto.
        </p>
      </div>
      {error && <p className="text-sm text-red-600">{error}</p>}
      {notice && <p className="text-sm text-emerald-600">{notice}</p>}

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="text-base">Fatture ({invoices.length})</CardTitle>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={runBilling} title="Genera le fatture del periodo per i servizi attivi">
              Esegui fatturazione
            </Button>
            <Button variant="outline" size="sm" onClick={runDunning} title="Sospendi i clienti con fatture scadute">
              Esegui dunning
            </Button>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <table className="w-full text-sm">
            <thead className="border-b border-border text-left text-muted-foreground">
              <tr>
                <th className="px-6 py-3 font-medium">Numero</th>
                <th className="px-6 py-3 font-medium">Cliente</th>
                <th className="px-6 py-3 font-medium">Totale</th>
                <th className="px-6 py-3 font-medium">Scadenza</th>
                <th className="px-6 py-3 font-medium">Stato</th>
                <th className="px-6 py-3" />
              </tr>
            </thead>
            <tbody>
              {invoices.map((inv) => {
                const state = isOverdue(inv) ? "overdue" : inv.status;
                return (
                  <tr key={inv.id} className="border-b border-border/60 last:border-0">
                    <td className="px-6 py-3 font-mono text-xs">{inv.number}</td>
                    <td className="px-6 py-3 font-medium">{clientName(inv.client_id)}</td>
                    <td className="px-6 py-3 text-muted-foreground">{euro(inv.total_cents)}</td>
                    <td className="px-6 py-3 text-muted-foreground">
                      {new Date(inv.due_at).toLocaleDateString("it-IT")}
                    </td>
                    <td className="px-6 py-3">
                      <span className={cn("rounded-md px-2 py-0.5 text-xs font-medium", badge[state])}>
                        {label[state] ?? state}
                      </span>
                    </td>
                    <td className="px-6 py-3 text-right">
                      {inv.status === "open" && (
                        <Button variant="outline" size="sm" onClick={() => pay(inv.id)}>
                          Segna pagata
                        </Button>
                      )}
                    </td>
                  </tr>
                );
              })}
              {invoices.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-6 py-8 text-center text-muted-foreground">
                    Nessuna fattura.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}
