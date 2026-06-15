"use client";

import { useEffect, useState } from "react";
import { Package } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { StatusBadge } from "@/components/ui/badge";
import { apiGet, apiPost } from "@/lib/api";

interface CatalogApp {
  slug: string;
  name: string;
  category: string;
  description: string;
}
interface InstalledApp {
  id: string;
  app: string;
  domain: string;
  version: string;
  status: string;
  installed_at: string;
}

export default function AppsPage() {
  const [catalog, setCatalog] = useState<CatalogApp[]>([]);
  const [installed, setInstalled] = useState<InstalledApp[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  async function refresh() {
    try {
      const [c, i] = await Promise.all([
        apiGet<{ apps: CatalogApp[] }>("/api/v1/apps/catalog"),
        apiGet<{ apps: InstalledApp[] }>("/api/v1/apps/installed"),
      ]);
      setCatalog(c.apps);
      setInstalled(i.apps);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    }
  }
  useEffect(() => {
    refresh();
  }, []);

  async function install(app: CatalogApp) {
    setBusy(app.slug);
    try {
      await apiPost("/api/v1/apps/install", { slug: app.slug, name: app.name });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Install failed");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">One-Click Apps</h1>
        <p className="text-sm text-muted-foreground">
          Install signed app recipes onto a site in one click — WordPress, Ghost, Nextcloud…
        </p>
      </header>

      {error && <p className="text-sm text-red-400">{error}</p>}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Installed ({installed.length})</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <table className="w-full text-sm">
            <thead className="border-b border-border text-left text-muted-foreground">
              <tr>
                <th className="px-6 py-3 font-medium">App</th>
                <th className="px-6 py-3 font-medium">Domain</th>
                <th className="px-6 py-3 font-medium">Version</th>
                <th className="px-6 py-3 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {installed.map((a) => (
                <tr key={a.id} className="border-b border-border/60 last:border-0">
                  <td className="px-6 py-3 font-medium">{a.app}</td>
                  <td className="px-6 py-3 text-muted-foreground">{a.domain}</td>
                  <td className="px-6 py-3 text-muted-foreground">{a.version}</td>
                  <td className="px-6 py-3">
                    <StatusBadge status={a.status === "running" ? "active" : a.status} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>

      <div>
        <h2 className="mb-3 text-sm font-medium text-muted-foreground">Catalog</h2>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {catalog.map((app) => (
            <Card key={app.slug}>
              <CardContent className="flex flex-col gap-3 p-5">
                <div className="flex items-center gap-3">
                  <div className="flex h-9 w-9 items-center justify-center rounded-md bg-primary/15 text-primary">
                    <Package className="h-4 w-4" />
                  </div>
                  <div>
                    <p className="font-medium">{app.name}</p>
                    <p className="text-xs text-muted-foreground">{app.category}</p>
                  </div>
                </div>
                <p className="text-sm text-muted-foreground">{app.description}</p>
                <Button
                  variant="outline"
                  size="sm"
                  className="mt-1 self-start"
                  disabled={busy === app.slug}
                  onClick={() => install(app)}
                >
                  {busy === app.slug ? "Installing…" : "Install"}
                </Button>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    </div>
  );
}
