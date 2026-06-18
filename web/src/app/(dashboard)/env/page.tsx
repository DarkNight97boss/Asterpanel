"use client";

import { useEffect, useState } from "react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { listEnv, listSecrets, type EnvVar, type SecretMeta } from "@/lib/api";

export default function EnvPage() {
  const [vars, setVars] = useState<EnvVar[]>([]);
  const [secrets, setSecrets] = useState<SecretMeta[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([listEnv(), listSecrets()])
      .then(([v, s]) => {
        setVars(v);
        setSecrets(s);
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Failed to load"));
  }, []);

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">Env &amp; Secrets</h1>
        <p className="text-sm text-muted-foreground">
          Plain environment variables and encrypted secrets (AES-256-GCM at rest — values never
          leave the server).
        </p>
      </header>

      {error && <p className="text-sm text-red-600">{error}</p>}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Environment variables ({vars.length})</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <table className="w-full text-sm">
            <thead className="border-b border-border text-left text-muted-foreground">
              <tr>
                <th className="px-6 py-3 font-medium">Key</th>
                <th className="px-6 py-3 font-medium">Value</th>
                <th className="px-6 py-3 font-medium">Scope</th>
              </tr>
            </thead>
            <tbody>
              {vars.map((v) => (
                <tr key={v.id} className="border-b border-border/60 last:border-0">
                  <td className="px-6 py-3 font-mono text-xs">{v.key}</td>
                  <td className="px-6 py-3 font-mono text-xs text-muted-foreground">{v.value}</td>
                  <td className="px-6 py-3 text-muted-foreground">
                    {v.is_build_time ? "build" : "runtime"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Secrets ({secrets.length})</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <table className="w-full text-sm">
            <thead className="border-b border-border text-left text-muted-foreground">
              <tr>
                <th className="px-6 py-3 font-medium">Key</th>
                <th className="px-6 py-3 font-medium">Value</th>
                <th className="px-6 py-3 font-medium">Version</th>
                <th className="px-6 py-3 font-medium">Updated</th>
              </tr>
            </thead>
            <tbody>
              {secrets.map((s) => (
                <tr key={s.id} className="border-b border-border/60 last:border-0">
                  <td className="px-6 py-3 font-mono text-xs">{s.key}</td>
                  <td className="px-6 py-3 font-mono text-xs text-muted-foreground">••••••••••</td>
                  <td className="px-6 py-3 text-muted-foreground">v{s.version}</td>
                  <td className="px-6 py-3 text-muted-foreground">
                    {new Date(s.updated_at).toLocaleDateString()}
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
