"use client";

import { useEffect, useState } from "react";
import { AlertOctagon, FileText, Inbox, Mail, Send, Trash2, type LucideIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { apiGet } from "@/lib/api";

interface Folder {
  name: string;
  count: number;
  unread: number;
}
interface Message {
  id: string;
  folder: string;
  from: string;
  from_email: string;
  subject: string;
  preview: string;
  date: string;
  unread: boolean;
  body: string;
}

const folderIcon: Record<string, LucideIcon> = {
  INBOX: Inbox,
  Sent: Send,
  Drafts: FileText,
  Spam: AlertOctagon,
  Trash: Trash2,
};

export default function WebmailPage() {
  const [folders, setFolders] = useState<Folder[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [folder, setFolder] = useState("INBOX");
  const [selected, setSelected] = useState<Message | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiGet<{ folders: Folder[]; messages: Message[] }>("/api/v1/email/messages")
      .then((r) => {
        setFolders(r.folders);
        setMessages(r.messages);
        setSelected(r.messages.find((m) => m.folder === "INBOX") ?? null);
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Failed to load"));
  }, []);

  const inFolder = messages.filter((m) => m.folder === folder);

  return (
    <div className="flex h-[calc(100vh-7rem)] flex-col gap-4">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Webmail</h1>
          <p className="text-sm text-muted-foreground">info@acme.com</p>
        </div>
        <Button>
          <Mail className="h-4 w-4" />
          Compose
        </Button>
      </header>

      {error && <p className="text-sm text-red-400">{error}</p>}

      <Card className="flex flex-1 overflow-hidden p-0">
        {/* folders */}
        <div className="w-44 shrink-0 border-r border-border p-2">
          {folders.map((f) => {
            const Icon = folderIcon[f.name] ?? Inbox;
            return (
              <button
                key={f.name}
                onClick={() => {
                  setFolder(f.name);
                  setSelected(messages.find((m) => m.folder === f.name) ?? null);
                }}
                className={cn(
                  "flex w-full items-center justify-between rounded-md px-3 py-2 text-sm transition-colors",
                  folder === f.name
                    ? "bg-primary/15 text-primary"
                    : "text-muted-foreground hover:bg-muted hover:text-foreground",
                )}
              >
                <span className="flex items-center gap-2">
                  <Icon className="h-4 w-4" />
                  {f.name}
                </span>
                {f.unread > 0 && (
                  <span className="rounded-full bg-primary px-1.5 text-[10px] font-medium text-primary-foreground">
                    {f.unread}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {/* message list */}
        <div className="w-80 shrink-0 overflow-y-auto border-r border-border">
          {inFolder.length === 0 && (
            <p className="p-6 text-center text-sm text-muted-foreground">No messages.</p>
          )}
          {inFolder.map((m) => (
            <button
              key={m.id}
              onClick={() => setSelected(m)}
              className={cn(
                "block w-full border-b border-border/60 px-4 py-3 text-left transition-colors hover:bg-muted/60",
                selected?.id === m.id && "bg-muted",
              )}
            >
              <div className="flex items-center justify-between">
                <span className={cn("truncate text-sm", m.unread ? "font-semibold" : "font-medium")}>
                  {m.from}
                </span>
                <span className="ml-2 shrink-0 text-[11px] text-muted-foreground">
                  {new Date(m.date).toLocaleDateString()}
                </span>
              </div>
              <p className={cn("truncate text-sm", m.unread ? "text-foreground" : "text-muted-foreground")}>
                {m.subject}
              </p>
              <p className="truncate text-xs text-muted-foreground">{m.preview}</p>
            </button>
          ))}
        </div>

        {/* reading pane */}
        <div className="flex-1 overflow-y-auto p-6">
          {selected ? (
            <article className="space-y-4">
              <div>
                <h2 className="text-lg font-semibold">{selected.subject}</h2>
                <p className="text-sm text-muted-foreground">
                  <span className="text-foreground">{selected.from}</span> &lt;{selected.from_email}&gt; ·{" "}
                  {new Date(selected.date).toLocaleString()}
                </p>
              </div>
              <div className="whitespace-pre-wrap border-t border-border pt-4 text-sm leading-relaxed">
                {selected.body}
              </div>
            </article>
          ) : (
            <p className="grid h-full place-items-center text-sm text-muted-foreground">
              Select a message
            </p>
          )}
        </div>
      </Card>
    </div>
  );
}
