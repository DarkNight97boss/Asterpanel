"use client";

import { useEffect, useState, type FormEvent } from "react";
import { ArrowLeft, LifeBuoy, Send } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { apiGet, apiPost } from "@/lib/api";
import { PageHeader } from "@/components/page-header";

interface Ticket {
  id: string;
  subject: string;
  status: "open" | "pending" | "closed";
  priority: "low" | "normal" | "high";
  message_count: number;
  created_at: string;
  updated_at: string;
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

const statusBadge: Record<string, string> = {
  open: "bg-emerald-500/15 text-emerald-600",
  pending: "bg-amber-500/15 text-amber-600",
  closed: "bg-muted text-muted-foreground",
};
const priorityBadge: Record<string, string> = {
  low: "text-muted-foreground",
  normal: "text-sky-600",
  high: "text-red-600",
};

export default function SupportPage() {
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [selected, setSelected] = useState<TicketDetail | null>(null);
  const [subject, setSubject] = useState("");
  const [priority, setPriority] = useState("normal");
  const [body, setBody] = useState("");
  const [reply, setReply] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    try {
      const { tickets } = await apiGet<{ tickets: Ticket[] }>("/api/v1/support/tickets");
      setTickets(tickets ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load tickets");
    }
  }
  useEffect(() => {
    load();
  }, []);

  async function openTicket(id: string) {
    setError(null);
    try {
      const { ticket } = await apiGet<{ ticket: TicketDetail }>(`/api/v1/support/tickets/${id}`);
      setSelected(ticket);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not open ticket");
    }
  }

  async function createTicket(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { ticket } = await apiPost<{ ticket: Ticket }>("/api/v1/support/tickets", {
        subject: subject.trim(),
        priority,
        body: body.trim(),
      });
      setSubject("");
      setBody("");
      setPriority("normal");
      await load();
      await openTicket(ticket.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not open ticket");
    } finally {
      setBusy(false);
    }
  }

  async function sendReply() {
    if (!selected || !reply.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await apiPost(`/api/v1/support/tickets/${selected.id}/reply`, { body: reply.trim() });
      setReply("");
      await openTicket(selected.id);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not send reply");
    } finally {
      setBusy(false);
    }
  }

  async function setStatus(status: "open" | "closed") {
    if (!selected) return;
    setError(null);
    try {
      await apiPost(`/api/v1/support/tickets/${selected.id}/status`, { status });
      setSelected({ ...selected, status });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not update status");
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Support"
        description="Open a ticket and chat with the team on a single thread."
      />
      {error && <p className="text-sm text-red-600">{error}</p>}

      {selected ? (
        <Card>
          <CardHeader className="flex flex-row items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setSelected(null)} aria-label="Back">
                <ArrowLeft className="h-4 w-4" />
              </Button>
              <div>
                <CardTitle className="text-base">{selected.subject}</CardTitle>
                <span className={cn("text-xs font-medium uppercase", priorityBadge[selected.priority])}>
                  {selected.priority} priority
                </span>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <span className={cn("rounded-full px-2 py-0.5 text-xs font-medium capitalize", statusBadge[selected.status])}>
                {selected.status}
              </span>
              {selected.status === "closed" ? (
                <Button variant="outline" size="sm" onClick={() => setStatus("open")}>
                  Reopen
                </Button>
              ) : (
                <Button variant="outline" size="sm" onClick={() => setStatus("closed")}>
                  Close
                </Button>
              )}
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-3">
              {selected.messages.map((m) => (
                <div
                  key={m.id}
                  className={cn("flex", m.staff ? "justify-start" : "justify-end")}
                >
                  <div
                    className={cn(
                      "max-w-[80%] rounded-lg px-3 py-2 text-sm",
                      m.staff ? "bg-muted" : "bg-primary/10",
                    )}
                  >
                    <div className="mb-0.5 text-[11px] font-medium text-muted-foreground">
                      {m.staff ? "Support" : "You"} · {new Date(m.created_at).toLocaleString()}
                    </div>
                    <div className="whitespace-pre-wrap">{m.body}</div>
                  </div>
                </div>
              ))}
            </div>
            {selected.status !== "closed" && (
              <div className="flex items-end gap-2 border-t border-border/60 pt-3">
                <textarea
                  className="min-h-[44px] flex-1 rounded-md border border-border bg-transparent px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                  placeholder="Write a reply…"
                  value={reply}
                  onChange={(e) => setReply(e.target.value)}
                />
                <Button onClick={sendReply} disabled={busy || !reply.trim()}>
                  <Send className="h-4 w-4" />
                  Send
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      ) : (
        <>
          <Card>
            <CardHeader>
              <CardTitle className="text-base">New ticket</CardTitle>
            </CardHeader>
            <CardContent>
              <form onSubmit={createTicket} className="space-y-3">
                <div className="flex flex-wrap items-end gap-3">
                  <div className="grow space-y-1">
                    <Label htmlFor="subject">Subject</Label>
                    <Input id="subject" value={subject} onChange={(e) => setSubject(e.target.value)} required />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="priority">Priority</Label>
                    <select
                      id="priority"
                      className="flex h-9 w-32 rounded-md border border-border bg-transparent px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                      value={priority}
                      onChange={(e) => setPriority(e.target.value)}
                    >
                      <option value="low" className="bg-card">Low</option>
                      <option value="normal" className="bg-card">Normal</option>
                      <option value="high" className="bg-card">High</option>
                    </select>
                  </div>
                </div>
                <div className="space-y-1">
                  <Label htmlFor="body">Message</Label>
                  <textarea
                    id="body"
                    className="min-h-[80px] w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                    value={body}
                    onChange={(e) => setBody(e.target.value)}
                    required
                  />
                </div>
                <Button type="submit" disabled={busy}>
                  {busy ? "Opening…" : "Open ticket"}
                </Button>
              </form>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Tickets ({tickets.length})</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <ul className="divide-y divide-border/60">
                {tickets.map((t) => (
                  <li key={t.id}>
                    <button
                      onClick={() => openTicket(t.id)}
                      className="flex w-full items-center gap-3 px-6 py-3 text-left text-sm hover:bg-muted/50"
                    >
                      <span className="font-medium">{t.subject}</span>
                      <span className={cn("text-xs font-medium uppercase", priorityBadge[t.priority])}>
                        {t.priority}
                      </span>
                      <span className="ml-auto text-xs text-muted-foreground">
                        {t.message_count} {t.message_count === 1 ? "message" : "messages"}
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
                    <span className="text-sm">No tickets yet. Open one above.</span>
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
