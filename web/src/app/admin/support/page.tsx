"use client";

import { useEffect, useState, type FormEvent } from "react";
import { ArrowLeft, LifeBuoy, Send } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { apiGet, apiPost } from "@/lib/api";

interface Ticket {
  id: string;
  client_id: string;
  subject: string;
  status: "open" | "pending" | "closed";
  priority: "low" | "normal" | "high";
  message_count: number;
}
interface TicketMessage {
  id: string;
  body: string;
  staff: boolean;
  created_at: string;
}
interface TicketDetail extends Ticket {
  messages: TicketMessage[];
}
interface Client {
  id: string;
  name: string;
}

const statusBadge: Record<string, string> = {
  open: "bg-emerald-500/15 text-emerald-600",
  pending: "bg-amber-500/15 text-amber-600",
  closed: "bg-muted text-muted-foreground",
};

export default function SupportPage() {
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [clients, setClients] = useState<Client[]>([]);
  const [selected, setSelected] = useState<TicketDetail | null>(null);
  const [clientId, setClientId] = useState("");
  const [subject, setSubject] = useState("");
  const [priority, setPriority] = useState("normal");
  const [body, setBody] = useState("");
  const [reply, setReply] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    try {
      const [t, c] = await Promise.all([
        apiGet<{ tickets: Ticket[] }>("/api/billing/tickets"),
        apiGet<{ clients: Client[] }>("/api/billing/clients"),
      ]);
      setTickets(t.tickets ?? []);
      setClients(c.clients ?? []);
      if (!clientId && c.clients?.length) setClientId(c.clients[0].id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Errore di caricamento");
    }
  }
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const clientName = (id: string) => clients.find((c) => c.id === id)?.name ?? id;

  async function open(id: string) {
    setError(null);
    try {
      const { ticket } = await apiGet<{ ticket: TicketDetail }>(`/api/billing/tickets/${id}`);
      setSelected(ticket);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Impossibile aprire il ticket");
    }
  }

  async function create(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { ticket } = await apiPost<{ ticket: Ticket }>("/api/billing/tickets", {
        client_id: clientId,
        subject: subject.trim(),
        priority,
        body: body.trim(),
      });
      setSubject("");
      setBody("");
      await load();
      await open(ticket.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Impossibile aprire il ticket");
    } finally {
      setBusy(false);
    }
  }

  async function sendReply() {
    if (!selected || !reply.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await apiPost(`/api/billing/tickets/${selected.id}/reply`, { body: reply.trim() });
      setReply("");
      await open(selected.id);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Risposta non inviata");
    } finally {
      setBusy(false);
    }
  }

  async function setStatus(status: "open" | "closed") {
    if (!selected) return;
    setError(null);
    try {
      await apiPost(`/api/billing/tickets/${selected.id}/status`, { status });
      setSelected({ ...selected, status });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Stato non aggiornato");
    }
  }

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-medium">Supporto</h1>
        <p className="text-sm text-muted-foreground">Ticket dei clienti, su un unico thread.</p>
      </div>
      {error && <p className="text-sm text-red-600">{error}</p>}

      {selected ? (
        <Card>
          <CardHeader className="flex flex-row items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setSelected(null)} aria-label="Indietro">
                <ArrowLeft className="h-4 w-4" />
              </Button>
              <div>
                <CardTitle className="text-base">{selected.subject}</CardTitle>
                <span className="text-xs text-muted-foreground">{clientName(selected.client_id)}</span>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <span className={cn("rounded-full px-2 py-0.5 text-xs font-medium capitalize", statusBadge[selected.status])}>
                {selected.status}
              </span>
              {selected.status === "closed" ? (
                <Button variant="outline" size="sm" onClick={() => setStatus("open")}>Riapri</Button>
              ) : (
                <Button variant="outline" size="sm" onClick={() => setStatus("closed")}>Chiudi</Button>
              )}
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-3">
              {selected.messages.map((mm) => (
                <div key={mm.id} className={cn("flex", mm.staff ? "justify-start" : "justify-end")}>
                  <div className={cn("max-w-[80%] rounded-lg px-3 py-2 text-sm", mm.staff ? "bg-muted" : "bg-primary/10")}>
                    <div className="mb-0.5 text-[11px] font-medium text-muted-foreground">
                      {mm.staff ? "Staff" : "Cliente"} · {new Date(mm.created_at).toLocaleString("it-IT")}
                    </div>
                    <div className="whitespace-pre-wrap">{mm.body}</div>
                  </div>
                </div>
              ))}
            </div>
            {selected.status !== "closed" && (
              <div className="flex items-end gap-2 border-t border-border/60 pt-3">
                <textarea
                  className="min-h-[44px] flex-1 rounded-md border border-border bg-transparent px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                  placeholder="Rispondi…"
                  value={reply}
                  onChange={(e) => setReply(e.target.value)}
                />
                <Button onClick={sendReply} disabled={busy || !reply.trim()}>
                  <Send className="h-4 w-4" /> Invia
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      ) : (
        <>
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Nuovo ticket</CardTitle>
            </CardHeader>
            <CardContent>
              <form onSubmit={create} className="space-y-3">
                <div className="flex flex-wrap items-end gap-3">
                  <div className="space-y-1">
                    <Label htmlFor="client">Cliente</Label>
                    <select
                      id="client"
                      className="flex h-9 w-44 rounded-md border border-border bg-transparent px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                      value={clientId}
                      onChange={(e) => setClientId(e.target.value)}
                    >
                      {clients.map((c) => (
                        <option key={c.id} value={c.id} className="bg-card">{c.name}</option>
                      ))}
                    </select>
                  </div>
                  <div className="grow space-y-1">
                    <Label htmlFor="subject">Oggetto</Label>
                    <Input id="subject" value={subject} onChange={(e) => setSubject(e.target.value)} required />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="priority">Priorità</Label>
                    <select
                      id="priority"
                      className="flex h-9 w-28 rounded-md border border-border bg-transparent px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                      value={priority}
                      onChange={(e) => setPriority(e.target.value)}
                    >
                      <option value="low" className="bg-card">bassa</option>
                      <option value="normal" className="bg-card">normale</option>
                      <option value="high" className="bg-card">alta</option>
                    </select>
                  </div>
                </div>
                <div className="space-y-1">
                  <Label htmlFor="body">Messaggio</Label>
                  <textarea
                    id="body"
                    className="min-h-[70px] w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                    value={body}
                    onChange={(e) => setBody(e.target.value)}
                    required
                  />
                </div>
                <Button type="submit" disabled={busy}>
                  {busy ? "Apertura…" : "Apri ticket"}
                </Button>
              </form>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Ticket ({tickets.length})</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <ul className="divide-y divide-border/60">
                {tickets.map((t) => (
                  <li key={t.id}>
                    <button onClick={() => open(t.id)} className="flex w-full items-center gap-3 px-6 py-3 text-left text-sm hover:bg-muted/50">
                      <div className="min-w-0">
                        <div className="truncate font-medium">{t.subject}</div>
                        <div className="text-xs text-muted-foreground">{clientName(t.client_id)}</div>
                      </div>
                      <span className={cn("ml-auto text-xs font-medium uppercase", t.priority === "high" ? "text-red-600" : "text-muted-foreground")}>
                        {t.priority}
                      </span>
                      <span className={cn("rounded-full px-2 py-0.5 text-xs font-medium capitalize", statusBadge[t.status])}>
                        {t.status}
                      </span>
                    </button>
                  </li>
                ))}
                {tickets.length === 0 && (
                  <li className="flex flex-col items-center gap-2 px-6 py-10 text-center text-muted-foreground">
                    <LifeBuoy className="h-6 w-6" />
                    <span className="text-sm">Nessun ticket.</span>
                  </li>
                )}
              </ul>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
