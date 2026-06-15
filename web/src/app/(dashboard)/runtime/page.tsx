"use client";

import { useEffect, useState } from "react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { apiGet } from "@/lib/api";

interface Runtime {
  site: string;
  runtime: string;
  version: string;
  available: string[];
}

export default function RuntimePage() {
  const [runtimes, setRuntimes] = useState<Runtime[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiGet<{ runtimes: Runtime[] }>("/api/v1/runtimes")
      .then((r) => setRuntimes(r.runtimes))
      .catch((e) => setError(e instanceof Error ? e.message : "Failed to load"));
  }, []);

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">Runtime</h1>
        <p className="text-sm text-muted-foreground">
          Per-site runtime and language version (PHP, Node…). Changing it redeploys the container.
        </p>
      </header>

      {error && <p className="text-sm text-red-400">{error}</p>}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Sites ({runtimes.length})</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <table className="w-full text-sm">
            <thead className="border-b border-border text-left text-muted-foreground">
              <tr>
                <th className="px-6 py-3 font-medium">Site</th>
                <th className="px-6 py-3 font-medium">Runtime</th>
                <th className="px-6 py-3 font-medium">Version</th>
              </tr>
            </thead>
            <tbody>
              {runtimes.map((r) => (
                <tr key={r.site} className="border-b border-border/60 last:border-0">
                  <td className="px-6 py-3 font-medium">{r.site}</td>
                  <td className="px-6 py-3 text-muted-foreground">{r.runtime}</td>
                  <td className="px-6 py-3">
                    {r.available.length === 0 ? (
                      <span className="text-muted-foreground">{r.version}</span>
                    ) : (
                      <select
                        defaultValue={r.version}
                        className="h-8 rounded-md border border-border bg-transparent px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                      >
                        {r.available.map((v) => (
                          <option key={v} value={v} className="bg-card">
                            {r.runtime} {v}
                          </option>
                        ))}
                      </select>
                    )}
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
