"use client";

import { useEffect, useState, type FormEvent } from "react";
import { Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { apiDelete, apiGet, apiPost } from "@/lib/api";

interface Rule {
  id: string;
  match_type: "path" | "user_agent" | "ip";
  pattern: string;
  note: string | null;
}

const MATCH_LABEL: Record<Rule["match_type"], string> = {
  path: "Path (regex)",
  user_agent: "User-Agent (regex)",
  ip: "IP / CIDR",
};

const PRESETS = [
  { label: "Block /wp-admin probes", match_type: "path", pattern: "(?i)/(wp-admin|wp-login)" },
  { label: "Block .env / .git access", match_type: "path", pattern: "(?i)/\\.(env|git)" },
  { label: "Block sqlmap scanner", match_type: "user_agent", pattern: "(?i)sqlmap" },
];

export default function WafPage() {
  const [rules, setRules] = useState<Rule[]>([]);
  const [matchType, setMatchType] = useState("path");
  const [pattern, setPattern] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    try {
      const { rules } = await apiGet<{ rules: Rule[] }>("/api/v1/waf");
      setRules(rules);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    }
  }
  useEffect(() => {
    refresh();
  }, []);

  async function create(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await apiPost("/api/v1/waf", { match_type: matchType, pattern, note });
      setPattern("");
      setNote("");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add rule");
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    try {
      await apiDelete(`/api/v1/waf/${id}`);
      setRules((prev) => prev.filter((r) => r.id !== id));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to delete");
    }
  }

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">WAF</h1>
        <p className="text-sm text-muted-foreground">
          Application-layer rules. Matching requests get a 403 at the edge proxy; every change
          dispatches a signed <code className="mx-1 rounded bg-muted px-1 text-xs">waf.apply</code>{" "}
          job that regenerates the Caddy ruleset.
        </p>
      </header>

      {error && <p className="text-sm text-red-400">{error}</p>}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">New rule</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <form onSubmit={create} className="flex flex-wrap items-end gap-3">
            <div className="space-y-1">
              <Label htmlFor="mt">Match</Label>
              <select
                id="mt"
                value={matchType}
                onChange={(e) => setMatchType(e.target.value)}
                className="h-9 rounded-md border border-input bg-background px-3 text-sm"
              >
                <option value="path">Path (regex)</option>
                <option value="user_agent">User-Agent (regex)</option>
                <option value="ip">IP / CIDR</option>
              </select>
            </div>
            <div className="grow space-y-1">
              <Label htmlFor="pattern">Pattern</Label>
              <Input
                id="pattern"
                value={pattern}
                onChange={(e) => setPattern(e.target.value)}
                placeholder="(?i)/wp-admin"
                required
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="note">Note</Label>
              <Input id="note" value={note} onChange={(e) => setNote(e.target.value)} />
            </div>
            <Button type="submit" disabled={busy}>
              Block
            </Button>
          </form>
          <div className="flex flex-wrap gap-2">
            {PRESETS.map((p) => (
              <button
                key={p.label}
                type="button"
                onClick={() => {
                  setMatchType(p.match_type);
                  setPattern(p.pattern);
                  setNote(p.label);
                }}
                className="rounded-full border border-border px-3 py-1 text-xs text-muted-foreground hover:text-foreground"
              >
                + {p.label}
              </button>
            ))}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Rules ({rules.length})</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <table className="w-full text-sm">
            <thead className="border-b border-border text-left text-muted-foreground">
              <tr>
                <th className="px-6 py-3 font-medium">Match</th>
                <th className="px-6 py-3 font-medium">Pattern</th>
                <th className="px-6 py-3 font-medium">Note</th>
                <th className="px-6 py-3" />
              </tr>
            </thead>
            <tbody>
              {rules.map((r) => (
                <tr key={r.id} className="border-b border-border/60 last:border-0">
                  <td className="px-6 py-3">
                    <span className="rounded-full bg-red-500/15 px-2 py-0.5 text-xs font-medium text-red-400">
                      {MATCH_LABEL[r.match_type]}
                    </span>
                  </td>
                  <td className="px-6 py-3 font-mono text-xs">{r.pattern}</td>
                  <td className="px-6 py-3 text-muted-foreground">{r.note}</td>
                  <td className="px-6 py-3 text-right">
                    <button
                      className="text-muted-foreground hover:text-red-400"
                      onClick={() => remove(r.id)}
                      aria-label="Delete rule"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </td>
                </tr>
              ))}
              {rules.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-6 py-8 text-center text-muted-foreground">
                    No WAF rules. Add one above or pick a preset.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}
