"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { apiGet, listWebsites, type Website } from "@/lib/api";

const TAIL_OPTIONS = [100, 200, 500, 1000];

export default function LogsPage() {
  const [sites, setSites] = useState<Website[]>([]);
  const [siteId, setSiteId] = useState("");
  const [tail, setTail] = useState(200);
  const [lines, setLines] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [auto, setAuto] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    listWebsites()
      .then((ws) => {
        setSites(ws);
        if (ws.length) setSiteId(ws[0].id);
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Failed to load sites"));
  }, []);

  const load = useCallback(async () => {
    if (!siteId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await apiGet<{ container: string; lines: string[] }>(
        `/api/v1/sites/${siteId}/logs?tail=${tail}`,
      );
      setLines(res.lines ?? []);
    } catch (e) {
      setLines([]);
      setError(e instanceof Error ? e.message : "Failed to load logs");
    } finally {
      setLoading(false);
    }
  }, [siteId, tail]);

  useEffect(() => {
    if (siteId) load();
  }, [siteId, tail, load]);

  // Auto-refresh every 5s when enabled.
  useEffect(() => {
    if (!auto || !siteId) return;
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [auto, siteId, load]);

  // Keep the view pinned to the newest line after each load.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines]);

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Logs</h1>
          <p className="text-sm text-muted-foreground">
            Live container logs for a site, tailed from the node.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={siteId}
            onChange={(e) => setSiteId(e.target.value)}
            className="h-9 rounded-md border border-input bg-background px-3 text-sm"
          >
            {sites.length === 0 && <option value="">No sites</option>}
            {sites.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
          <select
            value={tail}
            onChange={(e) => setTail(Number(e.target.value))}
            className="h-9 rounded-md border border-input bg-background px-3 text-sm"
          >
            {TAIL_OPTIONS.map((n) => (
              <option key={n} value={n}>
                {n} lines
              </option>
            ))}
          </select>
          <Button
            variant={auto ? "default" : "outline"}
            size="sm"
            onClick={() => setAuto((a) => !a)}
          >
            {auto ? "Auto: on" : "Auto: off"}
          </Button>
          <Button variant="outline" size="sm" disabled={!siteId || loading} onClick={load}>
            <RefreshCw className={loading ? "h-4 w-4 animate-spin" : "h-4 w-4"} />
            Refresh
          </Button>
        </div>
      </header>

      {error && <p className="text-sm text-red-400">{error}</p>}

      <Card>
        <CardContent className="p-0">
          <div
            ref={scrollRef}
            className="h-[65vh] overflow-auto bg-black/40 p-4 font-mono text-xs leading-relaxed"
          >
            {lines.length === 0 ? (
              <p className="text-muted-foreground">
                {siteId ? "No log output." : "Select a site to view its logs."}
              </p>
            ) : (
              lines.map((l, i) => (
                <div key={i} className="whitespace-pre-wrap break-all text-foreground/90">
                  {l}
                </div>
              ))
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
