"use client";

import { useEffect, useState, type FormEvent } from "react";
import { Server } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { apiGet, apiPost } from "@/lib/api";

// In production the logged-in session identifies the client; the demo fixes it.
const CLIENT_ID = "cli_globex";

interface Service {
  id: string;
  product: string;
  plan_code: string;
  status: string;
}
interface Invoice {
  id: string;
  number: string;
  status: string;
  total_cents: number;
  due_at: string;
}
interface Ticket {
  id: string;
  subject: string;
  status: string;
  priority: string;
  message_count: number;
}

const euro = (cents: number) => `€${(cents / 100).toLocaleString("it-IT")}`;
const svcBadge: Record<string, string> = {
  active: "bg-emerald-500/15 text-emerald-600",
  suspended: "bg-amber-500/15 text-amber-600",
  terminated: "bg-muted text-muted-foreground",
};
const invBadge: Record<string, string> = {
  paid: "bg-emerald-500/15 text-emerald-600",
  open: "bg-amber-500/15 text-amber-600",
  void: "bg-muted text-muted-foreground",
};
const tktBadge: Record<string, string> = {
  open: "bg-emerald-500/15 text-emerald-600",
  pending: "bg-amber-500/15 text-amber-600",
  closed: "bg-muted text-muted-foreground",
};

export default function PortalPage() {
  const [services, setServices] = useState<Service[]>([]);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function load() {
    try {
      const q = `?client_id=${CLIENT_ID}`;
      const [s, i, t] = await Promise.all([
        apiGet<{ services: Service[] }>(`/api/billing/services${q}`),
        apiGet<{ invoices: Invoice[] }>(`/api/billing/invoices${q}`),
        apiGet<{ tickets: Ticket[] }>(`/api/billing/tickets${q}`),
      ]);
      setServices(s.services ?? []);
      setInvoices(i.invoices ?? []);
      setTickets(t.tickets ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Errore di caricamento");
    }
  }
  useEffect(() => {
    load();
  }, []);

  async function pay(id: string) {
    setError(null);
    setNotice(null);
    try {
      await apiPost(`/api/billing/invoices/${id}/pay`, {});
      setNotice("Fattura saldata. Grazie!");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Pagamento non riuscito");
    }
  }

  async function openTicket(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    try {
      await apiPost("/api/billing/tickets", {
        client_id: CLIENT_ID,
        subject: subject.trim(),
        priority: "normal",
        body: body.trim(),
      });
      setSubject("");
      setBody("");
      setNotice("Ticket aperto. Ti risponderemo a breve.");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Impossibile aprire il ticket");
    }
  }

  return (
    <>
      <div>
        <h1 className="text-xl font-medium">Ciao, Globex SpA</h1>
        <p className="text-sm text-muted-foreground">I tuoi servizi, le fatture e il supporto.</p>
      </div>
      {error && <p className="text-sm text-red-600">{error}</p>}
      {notice && <p className="text-sm text-emerald-600">{notice}</p>}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">I miei servizi</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2.5">
          {services.map((s) => (
            <div key={s.id} className="flex items-center gap-3 text-sm">
              <Server className="h-4 w-4 text-muted-foreground" />
              <span className="font-medium">{s.product || s.plan_code}</span>
              <span className={cn("ml-auto rounded-md px-2 py-0.5 text-xs font-medium capitalize", svcBadge[s.status])}>
                {s.status}
              </span>
            </div>
          ))}
          {services.length === 0 && <p className="text-sm text-muted-foreground">Nessun servizio.</p>}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Le mie fatture</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2.5">
          {invoices.map((inv) => (
            <div key={inv.id} className="flex items-center gap-3 text-sm">
              <span className="font-mono text-xs">{inv.number}</span>
              <span className="text-muted-foreground">{euro(inv.total_cents)}</span>
              <span className={cn("rounded-md px-2 py-0.5 text-xs font-medium capitalize", invBadge[inv.status])}>
                {inv.status === "paid" ? "pagata" : inv.status === "open" ? "aperta" : inv.status}
              </span>
              {inv.status === "open" && (
                <Button size="sm" className="ml-auto" onClick={() => pay(inv.id)}>
                  Paga ora
                </Button>
              )}
            </div>
          ))}
          {invoices.length === 0 && <p className="text-sm text-muted-foreground">Nessuna fattura.</p>}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Supporto</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <form onSubmit={openTicket} className="space-y-2">
            <div className="space-y-1">
              <Label htmlFor="subject">Apri un ticket</Label>
              <Input id="subject" placeholder="Oggetto" value={subject} onChange={(e) => setSubject(e.target.value)} required />
            </div>
            <textarea
              className="min-h-[60px] w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              placeholder="Descrivi il problema…"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              required
            />
            <Button type="submit" size="sm">Invia richiesta</Button>
          </form>
          {tickets.length > 0 && (
            <ul className="divide-y divide-border/60 rounded-md border border-border/60">
              {tickets.map((t) => (
                <li key={t.id} className="flex items-center gap-3 px-4 py-2 text-sm">
                  <span className="min-w-0 flex-1 truncate">{t.subject}</span>
                  <span className="text-xs text-muted-foreground">{t.message_count} msg</span>
                  <span className={cn("rounded-full px-2 py-0.5 text-xs font-medium capitalize", tktBadge[t.status])}>
                    {t.status}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </>
  );
}
