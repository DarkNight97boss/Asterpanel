"use client";

import { useEffect, useState } from "react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { StatusBadge } from "@/components/ui/badge";
import { apiGet } from "@/lib/api";

interface ApiToken {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  last_used_at: string | null;
  expires_at: string | null;
  revoked: boolean;
  created_at: string;
}

export default function TokensPage() {
  const [tokens, setTokens] = useState<ApiToken[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiGet<{ api_tokens: ApiToken[] }>("/api/v1/api-tokens")
      .then((r) => setTokens(r.api_tokens))
      .catch((e) => setError(e instanceof Error ? e.message : "Failed to load"));
  }, []);

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">API Tokens</h1>
        <p className="text-sm text-muted-foreground">
          Scoped machine credentials (`astp_…`). A token can only carry scopes its creator holds.
        </p>
      </header>

      {error && <p className="text-sm text-red-400">{error}</p>}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Tokens ({tokens.length})</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <table className="w-full text-sm">
            <thead className="border-b border-border text-left text-muted-foreground">
              <tr>
                <th className="px-6 py-3 font-medium">Name</th>
                <th className="px-6 py-3 font-medium">Prefix</th>
                <th className="px-6 py-3 font-medium">Scopes</th>
                <th className="px-6 py-3 font-medium">Last used</th>
                <th className="px-6 py-3 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {tokens.map((t) => (
                <tr key={t.id} className="border-b border-border/60 last:border-0">
                  <td className="px-6 py-3 font-medium">{t.name}</td>
                  <td className="px-6 py-3 font-mono text-xs text-muted-foreground">
                    astp_{t.prefix}…
                  </td>
                  <td className="px-6 py-3">
                    <div className="flex flex-wrap gap-1">
                      {t.scopes.map((s) => (
                        <span key={s} className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px]">
                          {s}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td className="px-6 py-3 text-muted-foreground">
                    {t.last_used_at ? new Date(t.last_used_at).toLocaleString() : "never"}
                  </td>
                  <td className="px-6 py-3">
                    <StatusBadge status={t.revoked ? "error" : "active"} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}
