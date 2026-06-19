"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, Info, ShieldAlert } from "lucide-react";

import { Card, CardContent } from "@/components/ui/card";
import { apiGet } from "@/lib/api";
import { PageHeader } from "@/components/page-header";
import { cn } from "@/lib/utils";

type Severity = "ok" | "info" | "warning" | "critical";

interface Finding {
  id: string;
  title: string;
  severity: Severity;
  detail: string;
  recommendation?: string;
}

interface Advisor {
  findings: Finding[];
  summary: Record<Severity, number>;
  score: number;
}

const SEV: Record<Severity, { icon: typeof Info; badge: string; label: string; rank: number }> = {
  critical: { icon: ShieldAlert, badge: "bg-red-500/15 text-red-600 dark:text-red-300", label: "Critical", rank: 3 },
  warning: { icon: AlertTriangle, badge: "bg-amber-500/15 text-amber-600 dark:text-amber-300", label: "Warning", rank: 2 },
  info: { icon: Info, badge: "bg-sky-500/15 text-sky-600 dark:text-sky-300", label: "Info", rank: 1 },
  ok: { icon: CheckCircle2, badge: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-300", label: "OK", rank: 0 },
};

function scoreTone(s: number) {
  if (s >= 85) return "text-emerald-600 dark:text-emerald-400";
  if (s >= 60) return "text-amber-600 dark:text-amber-400";
  return "text-red-600 dark:text-red-400";
}

export default function AdvisorPage() {
  const [data, setData] = useState<Advisor | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    apiGet<Advisor>("/api/v1/security/advisor")
      .then(setData)
      .catch((e) => setError(e instanceof Error ? e.message : "Failed to load"))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Security Advisor"
        description="A read-only audit of your configuration with prioritized recommendations."
      />

      {error && <p className="text-sm text-red-600">{error}</p>}
      {loading && <p className="text-sm text-muted-foreground">Running checks…</p>}

      {data && (
        <>
          <Card>
            <CardContent className="flex flex-wrap items-center gap-6 pt-6">
              <div className="flex items-center gap-4">
                <div className={cn("text-4xl font-semibold", scoreTone(data.score))}>{data.score}</div>
                <div>
                  <p className="text-sm font-medium">Security score</p>
                  <p className="text-xs text-muted-foreground">out of 100</p>
                </div>
              </div>
              <div className="ml-auto flex flex-wrap gap-2 text-xs">
                {(["critical", "warning", "info", "ok"] as Severity[]).map((k) =>
                  data.summary[k] > 0 ? (
                    <span key={k} className={cn("rounded-full px-2.5 py-1 font-medium", SEV[k].badge)}>
                      {data.summary[k]} {SEV[k].label.toLowerCase()}
                    </span>
                  ) : null,
                )}
              </div>
            </CardContent>
          </Card>

          <div className="space-y-3">
            {[...data.findings]
              .sort((a, b) => SEV[b.severity].rank - SEV[a.severity].rank)
              .map((f) => {
                const s = SEV[f.severity];
                const Icon = s.icon;
                return (
                  <Card key={f.id}>
                    <CardContent className="flex items-start gap-4 pt-6">
                      <span
                        className={cn(
                          "mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg",
                          s.badge,
                        )}
                      >
                        <Icon className="h-4 w-4" />
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <p className="font-medium">{f.title}</p>
                          <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-medium", s.badge)}>
                            {s.label}
                          </span>
                        </div>
                        <p className="mt-0.5 text-sm text-muted-foreground">{f.detail}</p>
                        {f.recommendation && (
                          <p className="mt-1 text-sm">
                            <span className="font-medium">Recommendation: </span>
                            <span className="text-muted-foreground">{f.recommendation}</span>
                          </p>
                        )}
                      </div>
                    </CardContent>
                  </Card>
                );
              })}
          </div>
        </>
      )}
    </div>
  );
}
