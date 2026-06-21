"use client";

import { useEffect, useState } from "react";
import { Plug, RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { apiGet } from "@/lib/api";

interface Backend {
  name: string;
  label: string;
  kind: string;
  configured: boolean;
  connected: boolean;
  accounts?: number;
}

export default function HostingPage() {
  const [backends, setBackends] = useState<Backend[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setBusy(true);
    try {
      const { backends } = await apiGet<{ backends: Backend[] }>("/api/billing/backends");
      setBackends(backends ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Errore di caricamento");
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    load();
  }, []);

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-medium">Backend hosting</h1>
          <p className="text-sm text-muted-foreground">
            Aster Billing è agnostico al pannello: ogni backend è un modulo collegabile.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={load} disabled={busy}>
          <RefreshCw className={cn("h-4 w-4", busy && "animate-spin")} /> Verifica
        </Button>
      </div>
      {error && <p className="text-sm text-red-600">{error}</p>}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {backends.map((b) => (
          <Card key={b.name}>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="flex items-center gap-2 text-base">
                <Plug className="h-4 w-4 text-muted-foreground" />
                {b.label}
              </CardTitle>
              <span
                className={cn(
                  "rounded-full px-2 py-0.5 text-xs font-medium",
                  b.connected
                    ? "bg-emerald-500/15 text-emerald-600"
                    : b.configured
                      ? "bg-amber-500/15 text-amber-600"
                      : "bg-muted text-muted-foreground",
                )}
              >
                {b.connected ? "Connesso" : b.configured ? "Errore" : "Disponibile"}
              </span>
            </CardHeader>
            <CardContent className="space-y-1 text-sm text-muted-foreground">
              <div>{b.kind}</div>
              {b.connected && b.accounts != null ? (
                <div className="text-foreground">{b.accounts} account gestiti</div>
              ) : (
                <div>{b.configured ? "Configurato" : "Modulo non configurato"}</div>
              )}
            </CardContent>
          </Card>
        ))}
      </div>

      <p className="text-xs text-muted-foreground">
        I moduli implementano l&apos;interfaccia <code className="font-mono">hosting.Backend</code>{" "}
        (crea / sospendi / riattiva / cambia pacchetto). cPanel/WHM e Plesk si attivano configurando
        le credenziali del rispettivo modulo.
      </p>
    </div>
  );
}
