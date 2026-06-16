"use client";

import { useEffect, useState, type FormEvent } from "react";
import { Copy, Send, Trash2, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { apiDelete, apiGet, apiPost } from "@/lib/api";
import { Feature, ProGate } from "@/lib/license";

interface Webhook {
  id: string;
  url: string;
  events: string[];
  active: boolean;
  last_status: number | null;
  last_delivered_at: string | null;
  created_at: string;
  secret_preview?: string;
  secret?: string;
}

interface CreatedHook extends Webhook {
  secret: string;
}

export default function WebhooksPage() {
  const [hooks, setHooks] = useState<Webhook[]>([]);
  const [events, setEvents] = useState<string[]>([]);
  const [url, setUrl] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<CreatedHook | null>(null);
  const [testing, setTesting] = useState<Record<string, boolean>>({});

  async function refresh() {
    try {
      const res = await apiGet<{ webhooks: Webhook[]; known_events: string[] }>("/api/v1/webhooks");
      setHooks(res.webhooks ?? []);
      setEvents(res.known_events ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    }
  }
  useEffect(() => {
    refresh();
  }, []);

  function togglePick(ev: string) {
    setPicked((prev) => (prev.includes(ev) ? prev.filter((e) => e !== ev) : [...prev, ev]));
  }

  async function create(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { webhook } = await apiPost<{ webhook: CreatedHook }>("/api/v1/webhooks", {
        url,
        events: picked,
      });
      setCreated(webhook);
      setUrl("");
      setPicked([]);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create webhook");
    } finally {
      setBusy(false);
    }
  }

  async function test(id: string) {
    setTesting((s) => ({ ...s, [id]: true }));
    setError(null);
    try {
      await apiPost(`/api/v1/webhooks/${id}/test`);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Test delivery failed");
    } finally {
      setTesting((s) => ({ ...s, [id]: false }));
    }
  }

  async function remove(id: string) {
    if (!window.confirm("Delete this webhook?")) return;
    try {
      await apiDelete(`/api/v1/webhooks/${id}`);
      setHooks((prev) => prev.filter((h) => h.id !== id));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to delete");
    }
  }

  return (
    <ProGate feature={Feature.WhiteLabel}>
      <div className="space-y-6">
        <header>
          <h1 className="text-2xl font-semibold">Webhooks</h1>
          <p className="text-sm text-muted-foreground">
            Outbound HTTPS callbacks for your platform events. Each delivery is signed
            <code className="mx-1 rounded bg-muted px-1 text-xs">HMAC-SHA256</code>
            in <code className="rounded bg-muted px-1 text-xs">X-AsterPanel-Signature</code>.
          </p>
        </header>

        {error && <p className="text-sm text-red-400">{error}</p>}

        {created && (
          <div className="rounded-md border border-emerald-500/40 bg-emerald-500/5 px-4 py-3 text-sm">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="font-medium text-emerald-400">Webhook created.</p>
                <p className="mt-1 text-muted-foreground">
                  Save this signing secret — it is shown <strong>only once</strong>:
                </p>
                <code className="mt-1 inline-block break-all rounded bg-background px-2 py-1 font-mono text-xs text-foreground">
                  {created.secret}
                </code>
              </div>
              <div className="flex items-center gap-1">
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => navigator.clipboard?.writeText(created.secret)}
                  aria-label="Copy secret"
                >
                  <Copy className="h-4 w-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => setCreated(null)}
                  aria-label="Dismiss"
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>
            </div>
          </div>
        )}

        <Card>
          <CardHeader>
            <CardTitle className="text-base">New webhook</CardTitle>
          </CardHeader>
          <CardContent>
            <form onSubmit={create} className="space-y-4">
              <div className="space-y-1">
                <Label htmlFor="url">Endpoint URL</Label>
                <Input
                  id="url"
                  type="url"
                  required
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="https://example.com/hooks/asterpanel"
                />
              </div>
              <div className="space-y-1">
                <Label>Events</Label>
                <p className="text-xs text-muted-foreground">
                  Pick the events to subscribe — none selected means <em>all events</em>.
                </p>
                <div className="flex flex-wrap gap-2 pt-1">
                  {events.map((ev) => {
                    const on = picked.includes(ev);
                    return (
                      <button
                        type="button"
                        key={ev}
                        onClick={() => togglePick(ev)}
                        className={cn(
                          "rounded-full border px-3 py-1 font-mono text-xs",
                          on
                            ? "border-primary bg-primary/15 text-primary"
                            : "border-border text-muted-foreground hover:text-foreground",
                        )}
                      >
                        {ev}
                      </button>
                    );
                  })}
                </div>
              </div>
              <Button type="submit" disabled={busy}>
                Create webhook
              </Button>
            </form>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Endpoints ({hooks.length})</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <table className="w-full text-sm">
              <thead className="border-b border-border text-left text-muted-foreground">
                <tr>
                  <th className="px-6 py-3 font-medium">URL</th>
                  <th className="px-6 py-3 font-medium">Events</th>
                  <th className="px-6 py-3 font-medium">Last delivery</th>
                  <th className="px-6 py-3" />
                </tr>
              </thead>
              <tbody>
                {hooks.map((h) => (
                  <tr key={h.id} className="border-b border-border/60 last:border-0">
                    <td className="px-6 py-3 font-mono text-xs">
                      <div className="break-all">{h.url}</div>
                      {h.secret_preview && (
                        <div className="text-[10px] text-muted-foreground">
                          secret {h.secret_preview}
                        </div>
                      )}
                    </td>
                    <td className="px-6 py-3 text-xs text-muted-foreground">
                      {h.events.length === 0 ? (
                        <span className="italic">all events</span>
                      ) : (
                        h.events.join(", ")
                      )}
                    </td>
                    <td className="px-6 py-3 text-xs">
                      {h.last_status == null ? (
                        <span className="text-muted-foreground">never</span>
                      ) : (
                        <span
                          className={cn(
                            "rounded px-1.5 py-0.5 font-mono",
                            h.last_status >= 200 && h.last_status < 300
                              ? "bg-emerald-500/15 text-emerald-400"
                              : "bg-red-500/15 text-red-400",
                          )}
                          title={h.last_delivered_at ?? ""}
                        >
                          {h.last_status === 0 ? "error" : h.last_status}
                        </span>
                      )}
                    </td>
                    <td className="px-6 py-3 text-right">
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={testing[h.id]}
                        onClick={() => test(h.id)}
                      >
                        <Send className={testing[h.id] ? "h-4 w-4 animate-pulse" : "h-4 w-4"} />
                        Test
                      </Button>
                      <button
                        className="ml-2 text-muted-foreground hover:text-red-400"
                        onClick={() => remove(h.id)}
                        aria-label="Delete webhook"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </td>
                  </tr>
                ))}
                {hooks.length === 0 && (
                  <tr>
                    <td colSpan={4} className="px-6 py-8 text-center text-muted-foreground">
                      No webhooks yet.
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
