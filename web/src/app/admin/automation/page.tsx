"use client";

import { useEffect, useState } from "react";
import { Bot, Play } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { apiGet, apiPost } from "@/lib/api";

interface Automation {
  enabled: boolean;
  interval_seconds: number;
  last_billing_run: string | null;
  last_dunning_run: string | null;
  last_generated: number;
  last_suspended: number;
}

const INTERVALS = [
  { label: "Ogni ora", value: 3600 },
  { label: "Ogni 12 ore", value: 43200 },
  { label: "Giornaliero", value: 86400 },
];

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString("it-IT") : "mai");

export default function AutomationPage() {
  const [a, setA] = useState<Automation | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function load() {
    try {
      const { automation } = await apiGet<{ automation: Automation }>("/api/billing/automation");
      setA(automation);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Errore di caricamento");
    }
  }
  useEffect(() => {
    load();
  }, []);

  async function patch(body: Partial<Automation>) {
    setError(null);
    try {
      const { automation } = await apiPost<{ automation: Automation }>("/api/billing/automation", body);
      setA(automation);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Aggiornamento non riuscito");
    }
  }

  async function runNow() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const { generated, suspended } = await apiPost<{ generated: number; suspended: number }>(
        "/api/billing/automation/run",
        {},
      );
      setNotice(`Ciclo eseguito: ${generated} fatture generate, ${suspended} servizi sospesi.`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Esecuzione non riuscita");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-medium">Automazione</h1>
          <p className="text-sm text-muted-foreground">
            Il cron non presidiato: fatturazione + dunning, eseguiti a intervalli.
          </p>
        </div>
        <Button size="sm" onClick={runNow} disabled={busy}>
          <Play className="h-4 w-4" /> {busy ? "In corso…" : "Esegui ora"}
        </Button>
      </div>
      {error && <p className="text-sm text-red-600">{error}</p>}
      {notice && <p className="text-sm text-emerald-600">{notice}</p>}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Bot className="h-4 w-4 text-muted-foreground" /> Pianificazione
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm font-medium">Automazione</div>
              <div className="text-xs text-muted-foreground">
                {a?.enabled ? "Attiva — il cron gira in background." : "In pausa."}
              </div>
            </div>
            <Button
              variant={a?.enabled ? "outline" : "default"}
              size="sm"
              onClick={() => patch({ enabled: !a?.enabled })}
            >
              {a?.enabled ? "Metti in pausa" : "Attiva"}
            </Button>
          </div>

          <div className="space-y-1">
            <Label htmlFor="interval">Intervallo</Label>
            <select
              id="interval"
              className="flex h-9 w-44 rounded-md border border-border bg-transparent px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              value={a?.interval_seconds ?? 86400}
              onChange={(e) => patch({ interval_seconds: Number(e.target.value) })}
            >
              {INTERVALS.map((i) => (
                <option key={i.value} value={i.value} className="bg-card">{i.label}</option>
              ))}
            </select>
          </div>

          <div className="grid grid-cols-2 gap-3 border-t border-border pt-4">
            <div className="rounded-md bg-muted/40 p-3">
              <div className="text-xs text-muted-foreground">Ultima fatturazione</div>
              <div className="text-sm font-medium">{when(a?.last_billing_run ?? null)}</div>
              <div className="text-xs text-muted-foreground">{a?.last_generated ?? 0} fatture</div>
            </div>
            <div className="rounded-md bg-muted/40 p-3">
              <div className="text-xs text-muted-foreground">Ultimo dunning</div>
              <div className="text-sm font-medium">{when(a?.last_dunning_run ?? null)}</div>
              <div className={cn("text-xs", (a?.last_suspended ?? 0) > 0 ? "text-amber-600" : "text-muted-foreground")}>
                {a?.last_suspended ?? 0} sospensioni
              </div>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
