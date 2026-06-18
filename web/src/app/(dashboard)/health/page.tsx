"use client";

import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { apiGet, apiPost } from "@/lib/api";

interface Health {
  website_id: string;
  site: string;
  status: "up" | "down" | "unknown";
  http_code: number | null;
  latency_ms: number | null;
  consecutive_failures: number;
  checked_at: string | null;
}

interface Incident {
  id: number;
  site: string;
  opened_at: string;
  closed_at: string | null;
  http_code: number | null;
  ongoing: boolean;
}

interface Service {
  name: string;
  state: string;
  status: string;
}

function duration(from: string, to: string | null) {
  const ms = (to ? new Date(to).getTime() : Date.now()) - new Date(from).getTime();
  const m = Math.max(0, Math.round(ms / 60000));
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

const badge: Record<Health["status"], string> = {
  up: "bg-emerald-500/15 text-emerald-600",
  down: "bg-red-500/15 text-red-600",
  unknown: "bg-muted text-muted-foreground",
};

export default function HealthPage() {
  const [sites, setSites] = useState<Health[]>([]);
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [services, setServices] = useState<Service[]>([]);
  const [svcBusy, setSvcBusy] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState<Record<string, boolean>>({});

  async function load() {
    try {
      const [h, inc, svc] = await Promise.all([
        apiGet<{ sites: Health[] }>("/api/v1/health"),
        apiGet<{ incidents: Incident[] }>("/api/v1/health/incidents"),
        apiGet<{ services: Service[] }>("/api/v1/services").catch(() => ({ services: [] })),
      ]);
      setSites(h.sites ?? []);
      setIncidents(inc.incidents ?? []);
      setServices(svc.services ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load health");
    }
  }

  async function onRestart(name: string) {
    setSvcBusy((b) => ({ ...b, [name]: true }));
    setError(null);
    try {
      await apiPost("/api/v1/services/restart", { name });
      const svc = await apiGet<{ services: Service[] }>("/api/v1/services");
      setServices(svc.services ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Restart failed");
    } finally {
      setSvcBusy((b) => ({ ...b, [name]: false }));
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function check(id: string) {
    setChecking((c) => ({ ...c, [id]: true }));
    setError(null);
    try {
      const { health } = await apiPost<{ health: Health }>(`/api/v1/sites/${id}/health/check`);
      setSites((prev) => prev.map((s) => (s.website_id === id ? { ...s, ...health } : s)));
      const inc = await apiGet<{ incidents: Incident[] }>("/api/v1/health/incidents");
      setIncidents(inc.incidents ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Health check failed");
    } finally {
      setChecking((c) => ({ ...c, [id]: false }));
    }
  }

  async function checkAll() {
    await Promise.all(sites.map((s) => check(s.website_id)));
  }

  const down = sites.filter((s) => s.status === "down").length;

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Health</h1>
          <p className="text-sm text-muted-foreground">
            Per-site liveness probes. {down > 0 ? `${down} site(s) down.` : "All monitored sites are up."}
          </p>
        </div>
        <Button variant="outline" size="sm" disabled={sites.length === 0} onClick={checkAll}>
          <RefreshCw className="h-4 w-4" />
          Check all
        </Button>
      </header>

      {error && <p className="text-sm text-red-600">{error}</p>}

      <Card>
        <CardContent className="p-0">
          <table className="w-full text-sm">
            <thead className="border-b border-border text-left text-muted-foreground">
              <tr>
                <th className="px-6 py-3 font-medium">Site</th>
                <th className="px-6 py-3 font-medium">Status</th>
                <th className="px-6 py-3 font-medium">Latency</th>
                <th className="px-6 py-3 font-medium">Last checked</th>
                <th className="px-6 py-3" />
              </tr>
            </thead>
            <tbody>
              {sites.map((s) => (
                <tr key={s.website_id} className="border-b border-border/60 last:border-0">
                  <td className="px-6 py-3 font-medium">{s.site}</td>
                  <td className="px-6 py-3">
                    <span
                      className={cn(
                        "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium capitalize",
                        badge[s.status],
                      )}
                    >
                      {s.status}
                      {s.status === "down" && s.consecutive_failures > 1
                        ? ` ×${s.consecutive_failures}`
                        : ""}
                    </span>
                  </td>
                  <td className="px-6 py-3 text-muted-foreground">
                    {s.latency_ms != null && s.latency_ms > 0 ? `${s.latency_ms} ms` : "—"}
                  </td>
                  <td className="px-6 py-3 text-muted-foreground">
                    {s.checked_at ? new Date(s.checked_at).toLocaleString() : "never"}
                  </td>
                  <td className="px-6 py-3 text-right">
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={checking[s.website_id]}
                      onClick={() => check(s.website_id)}
                    >
                      <RefreshCw
                        className={checking[s.website_id] ? "h-4 w-4 animate-spin" : "h-4 w-4"}
                      />
                      Check
                    </Button>
                  </td>
                </tr>
              ))}
              {sites.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-6 py-8 text-center text-muted-foreground">
                    No sites to monitor yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Services ({services.length})</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <table className="w-full text-sm">
            <thead className="border-b border-border text-left text-muted-foreground">
              <tr>
                <th className="px-6 py-3 font-medium">Container</th>
                <th className="px-6 py-3 font-medium">State</th>
                <th className="px-6 py-3 font-medium">Status</th>
                <th className="px-6 py-3" />
              </tr>
            </thead>
            <tbody>
              {services.map((sv) => (
                <tr key={sv.name} className="border-b border-border/60 last:border-0">
                  <td className="px-6 py-3 font-mono text-xs">{sv.name}</td>
                  <td className="px-6 py-3">
                    <span
                      className={cn(
                        "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium capitalize",
                        sv.state === "running"
                          ? "bg-emerald-500/15 text-emerald-600"
                          : "bg-red-500/15 text-red-600",
                      )}
                    >
                      {sv.state}
                    </span>
                  </td>
                  <td className="px-6 py-3 text-muted-foreground">{sv.status}</td>
                  <td className="px-6 py-3 text-right">
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={svcBusy[sv.name]}
                      onClick={() => onRestart(sv.name)}
                    >
                      <RefreshCw className={svcBusy[sv.name] ? "h-4 w-4 animate-spin" : "h-4 w-4"} />
                      Restart
                    </Button>
                  </td>
                </tr>
              ))}
              {services.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-6 py-8 text-center text-muted-foreground">
                    No containers reported by the node.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </CardContent>
      </Card>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-muted-foreground">Incident timeline</h2>
        {incidents.length === 0 ? (
          <p className="text-sm text-muted-foreground">No incidents recorded.</p>
        ) : (
          <ol className="space-y-2">
            {incidents.map((i) => (
              <li
                key={i.id}
                className="flex items-center gap-3 rounded-md border border-border/60 px-4 py-2 text-sm"
              >
                <span
                  className={cn(
                    "h-2 w-2 shrink-0 rounded-full",
                    i.ongoing ? "bg-red-400 animate-pulse" : "bg-emerald-400",
                  )}
                />
                <span className="font-medium">{i.site}</span>
                <span className="text-muted-foreground">
                  {new Date(i.opened_at).toLocaleString()}
                  {i.http_code ? ` · HTTP ${i.http_code}` : ""}
                </span>
                <span
                  className={cn(
                    "ml-auto rounded-full px-2 py-0.5 text-xs",
                    i.ongoing ? "bg-red-500/15 text-red-600" : "bg-muted text-muted-foreground",
                  )}
                >
                  {i.ongoing ? `ongoing · ${duration(i.opened_at, null)}` : `resolved · ${duration(i.opened_at, i.closed_at)}`}
                </span>
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}
