"use client";

import { useEffect, useState } from "react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { apiGet } from "@/lib/api";
import { PageHeader } from "@/components/page-header";

interface AuditEvent {
  id: string;
  action: string;
  actor: string;
  resource: string;
  outcome: string;
  ip: string;
  at: string;
}

const outcomeTone: Record<string, string> = {
  success: "border-emerald-500/30 bg-emerald-500/15 text-emerald-600",
  failure: "border-red-500/30 bg-red-500/15 text-red-600",
  denied: "border-amber-500/30 bg-amber-500/15 text-amber-600",
};

export default function AuditPage() {
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiGet<{ events: AuditEvent[] }>("/api/v1/audit")
      .then((r) => setEvents(r.events))
      .catch((e) => setError(e instanceof Error ? e.message : "Failed to load"));
  }, []);

  return (
    <div className="space-y-6">
      <PageHeader title={"Audit Log"} description={"Append-only, hash-chained record of every privileged action (tamper-evident)."} />

      {error && <p className="text-sm text-red-600">{error}</p>}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Events ({events.length})</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <table className="w-full text-sm">
            <thead className="border-b border-border text-left text-muted-foreground">
              <tr>
                <th className="px-6 py-3 font-medium">Action</th>
                <th className="px-6 py-3 font-medium">Actor</th>
                <th className="px-6 py-3 font-medium">Resource</th>
                <th className="px-6 py-3 font-medium">Outcome</th>
                <th className="px-6 py-3 font-medium">IP</th>
                <th className="px-6 py-3 font-medium">When</th>
              </tr>
            </thead>
            <tbody>
              {events.map((e) => (
                <tr key={e.id} className="border-b border-border/60 last:border-0">
                  <td className="px-6 py-3 font-mono text-xs">{e.action}</td>
                  <td className="px-6 py-3 text-muted-foreground">{e.actor}</td>
                  <td className="px-6 py-3 text-muted-foreground">{e.resource}</td>
                  <td className="px-6 py-3">
                    <span
                      className={cn(
                        "rounded-full border px-2 py-0.5 text-xs font-medium",
                        outcomeTone[e.outcome] ?? outcomeTone.success,
                      )}
                    >
                      {e.outcome}
                    </span>
                  </td>
                  <td className="px-6 py-3 font-mono text-xs text-muted-foreground">{e.ip}</td>
                  <td className="px-6 py-3 text-muted-foreground">{new Date(e.at).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}
