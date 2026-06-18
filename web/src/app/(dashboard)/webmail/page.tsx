"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Inbox, Mail, RefreshCw, Send, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import {
  listMailboxes,
  webmailFolders,
  webmailMessage,
  webmailMessages,
  webmailSend,
  type Mailbox,
  type WebmailFolder,
  type WebmailHeader,
  type WebmailMessage,
} from "@/lib/api";
import { PageHeader } from "@/components/page-header";

function msg(e: unknown) {
  return e instanceof Error ? e.message : "error";
}

export default function WebmailPage() {
  const [mailboxes, setMailboxes] = useState<Mailbox[]>([]);
  const [mailboxId, setMailboxId] = useState("");
  const [folders, setFolders] = useState<WebmailFolder[]>([]);
  const [folder, setFolder] = useState("INBOX");
  const [messages, setMessages] = useState<WebmailHeader[]>([]);
  const [selectedUid, setSelectedUid] = useState<number | null>(null);
  const [message, setMessage] = useState<WebmailMessage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const [compose, setCompose] = useState(false);
  const [to, setTo] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);

  useEffect(() => {
    listMailboxes()
      .then((m) => {
        setMailboxes(m);
        if (m.length) setMailboxId(m[0].id);
      })
      .catch((e) => setError(msg(e)));
  }, []);

  const loadFolders = useCallback(async (id: string) => {
    try {
      const f = await webmailFolders(id);
      setFolders(f.length ? f : [{ name: "INBOX" }]);
    } catch {
      setFolders([{ name: "INBOX" }]);
    }
  }, []);

  const loadMessages = useCallback(async (id: string, fld: string) => {
    setLoading(true);
    setMessage(null);
    setSelectedUid(null);
    setError(null);
    try {
      setMessages(await webmailMessages(id, fld));
    } catch (e) {
      setError(msg(e));
      setMessages([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!mailboxId) return;
    loadFolders(mailboxId);
    loadMessages(mailboxId, folder);
  }, [mailboxId, folder, loadFolders, loadMessages]);

  async function openMessage(uid: number) {
    setSelectedUid(uid);
    setMessage(null);
    try {
      setMessage(await webmailMessage(mailboxId, folder, uid));
    } catch (e) {
      setError(msg(e));
    }
  }

  async function onSend(e: FormEvent) {
    e.preventDefault();
    setSending(true);
    setError(null);
    try {
      await webmailSend(mailboxId, { to, subject, body });
      setSent(true);
      setCompose(false);
      setTo("");
      setSubject("");
      setBody("");
      setTimeout(() => setSent(false), 4000);
    } catch (e) {
      setError(msg(e));
    } finally {
      setSending(false);
    }
  }

  if (mailboxes.length === 0) {
    return (
      <div className="space-y-6">
        <PageHeader title={"Webmail"} description={"Native IMAP/SMTP client built into the panel."} />
        {error && <p className="text-sm text-red-600">{error}</p>}
        <Card className="p-10 text-center text-sm text-muted-foreground">
          No mailbox yet — create one in <span className="text-foreground">Mailboxes</span> first.
        </Card>
      </div>
    );
  }

  return (
    <div className="flex h-[calc(100vh-7rem)] flex-col gap-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <PageHeader title="Webmail" />
          <select
            value={mailboxId}
            onChange={(e) => setMailboxId(e.target.value)}
            className="h-9 rounded-md border border-border bg-transparent px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            {mailboxes.map((m) => (
              <option key={m.id} value={m.id} className="bg-card">
                {m.address}
              </option>
            ))}
          </select>
        </div>
        <div className="flex items-center gap-2">
          {sent && <span className="text-sm text-emerald-600">Sent ✓</span>}
          <Button variant="outline" size="icon" onClick={() => loadMessages(mailboxId, folder)} title="Refresh">
            <RefreshCw className="h-4 w-4" />
          </Button>
          <Button onClick={() => setCompose(true)}>
            <Mail className="h-4 w-4" />
            Compose
          </Button>
        </div>
      </header>

      {error && <p className="text-sm text-red-600">{error}</p>}

      <Card className="flex flex-1 overflow-hidden p-0">
        {/* folders */}
        <div className="w-44 shrink-0 overflow-y-auto border-r border-border p-2">
          {folders.map((f) => (
            <button
              key={f.name}
              onClick={() => setFolder(f.name)}
              className={cn(
                "flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors",
                folder === f.name
                  ? "bg-primary/15 text-primary"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground",
              )}
            >
              <Inbox className="h-4 w-4" />
              {f.name}
            </button>
          ))}
        </div>

        {/* message list */}
        <div className="w-80 shrink-0 overflow-y-auto border-r border-border">
          {loading && <p className="p-6 text-center text-sm text-muted-foreground">Loading…</p>}
          {!loading && messages.length === 0 && (
            <p className="p-6 text-center text-sm text-muted-foreground">No messages.</p>
          )}
          {messages.map((m) => (
            <button
              key={m.uid}
              onClick={() => openMessage(m.uid)}
              className={cn(
                "block w-full border-b border-border/60 px-4 py-3 text-left transition-colors hover:bg-muted/60",
                selectedUid === m.uid && "bg-muted",
              )}
            >
              <div className="flex items-center justify-between">
                <span className={cn("truncate text-sm", m.seen ? "font-medium" : "font-semibold")}>
                  {m.from || "(unknown)"}
                </span>
                <span className="ml-2 shrink-0 text-[11px] text-muted-foreground">
                  {m.date ? new Date(m.date).toLocaleDateString() : ""}
                </span>
              </div>
              <p className={cn("truncate text-sm", m.seen ? "text-muted-foreground" : "text-foreground")}>
                {m.subject || "(no subject)"}
              </p>
            </button>
          ))}
        </div>

        {/* reading pane */}
        <div className="flex-1 overflow-y-auto p-6">
          {!message ? (
            <p className="grid h-full place-items-center text-sm text-muted-foreground">
              {selectedUid ? "Loading…" : "Select a message"}
            </p>
          ) : (
            <article className="flex h-full flex-col gap-4">
              <div>
                <h2 className="text-lg font-semibold">{message.subject || "(no subject)"}</h2>
                <p className="text-sm text-muted-foreground">
                  <span className="text-foreground">{message.from}</span> ·{" "}
                  {message.date ? new Date(message.date).toLocaleString() : ""}
                </p>
              </div>
              {message.body_text ? (
                <div className="whitespace-pre-wrap border-t border-border pt-4 text-sm leading-relaxed">
                  {message.body_text}
                </div>
              ) : (
                // HTML email rendered in a sandboxed iframe (no script execution).
                <iframe
                  title="message"
                  sandbox=""
                  className="flex-1 w-full rounded border border-border bg-white"
                  srcDoc={message.body_html || "<p>(empty)</p>"}
                />
              )}
            </article>
          )}
        </div>
      </Card>

      {compose && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4">
          <Card className="w-full max-w-xl">
            <form onSubmit={onSend} className="space-y-4 p-6">
              <div className="flex items-center justify-between">
                <h3 className="font-semibold">New message</h3>
                <button type="button" onClick={() => setCompose(false)} className="text-muted-foreground hover:text-foreground">
                  <X className="h-5 w-5" />
                </button>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="to">To</Label>
                <Input id="to" type="email" value={to} onChange={(e) => setTo(e.target.value)} required />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="subject">Subject</Label>
                <Input id="subject" value={subject} onChange={(e) => setSubject(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="cbody">Message</Label>
                <textarea
                  id="cbody"
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  rows={8}
                  className="w-full rounded-md border border-border bg-transparent p-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                  required
                />
              </div>
              <div className="flex justify-end gap-2">
                <Button type="button" variant="outline" onClick={() => setCompose(false)}>
                  Cancel
                </Button>
                <Button type="submit" disabled={sending}>
                  <Send className="h-4 w-4" />
                  {sending ? "Sending…" : "Send"}
                </Button>
              </div>
            </form>
          </Card>
        </div>
      )}
    </div>
  );
}
