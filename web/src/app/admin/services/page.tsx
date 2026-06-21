"use client";

import { useEffect, useState, type FormEvent } from "react";
import { Server } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { apiGet, apiPost } from "@/lib/api";

interface Client {
  id: string;
  name: string;
}
interface Product {
  id: string;
  name: string;
  plan_code: string;
}
interface Service {
  id: string;
  client_id: string;
  product: string;
  plan_code: string;
  backend: string;
  hosting_account_id: string;
  status: string;
}

const statusBadge: Record<string, string> = {
  active: "bg-emerald-500/15 text-emerald-600",
  suspended: "bg-amber-500/15 text-amber-600",
  pending: "bg-sky-500/15 text-sky-600",
  terminated: "bg-muted text-muted-foreground",
};

export default function ServicesPage() {
  const [services, setServices] = useState<Service[]>([]);
  const [clients, setClients] = useState<Client[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [clientId, setClientId] = useState("");
  const [productId, setProductId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function load() {
    try {
      const [s, c, p] = await Promise.all([
        apiGet<{ services: Service[] }>("/api/billing/services"),
        apiGet<{ clients: Client[] }>("/api/billing/clients"),
        apiGet<{ products: Product[] }>("/api/billing/products"),
      ]);
      setServices(s.services ?? []);
      setClients(c.clients ?? []);
      setProducts(p.products ?? []);
      if (!clientId && c.clients?.length) setClientId(c.clients[0].id);
      if (!productId && p.products?.length) setProductId(p.products[0].id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Errore di caricamento");
    }
  }
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const clientName = (id: string) => clients.find((c) => c.id === id)?.name ?? id;

  async function create(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await apiPost<{ temp_password?: string }>("/api/billing/services", {
        client_id: clientId,
        product_id: productId,
      });
      setNotice(
        res.temp_password
          ? `Servizio provisionato sul pannello hosting. Password una-tantum: ${res.temp_password}`
          : "Servizio provisionato.",
      );
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Provisioning non riuscito");
    } finally {
      setBusy(false);
    }
  }

  async function toggle(s: Service) {
    setError(null);
    const action = s.status === "suspended" ? "unsuspend" : "suspend";
    try {
      await apiPost(`/api/billing/services/${s.id}/${action}`, {});
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Operazione non riuscita");
    }
  }

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-medium">Servizi</h1>
        <p className="text-sm text-muted-foreground">
          Creare un servizio provisiona un account reale sul pannello hosting, tramite il modulo.
        </p>
      </div>
      {error && <p className="text-sm text-red-600">{error}</p>}
      {notice && <p className="text-sm text-emerald-600">{notice}</p>}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Nuovo servizio</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={create} className="flex flex-wrap items-end gap-3">
            <div className="space-y-1">
              <Label htmlFor="client">Cliente</Label>
              <select
                id="client"
                className="flex h-9 w-44 rounded-md border border-border bg-transparent px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                value={clientId}
                onChange={(e) => setClientId(e.target.value)}
              >
                {clients.map((c) => (
                  <option key={c.id} value={c.id} className="bg-card">
                    {c.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="grow space-y-1">
              <Label htmlFor="product">Prodotto</Label>
              <select
                id="product"
                className="flex h-9 w-full rounded-md border border-border bg-transparent px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                value={productId}
                onChange={(e) => setProductId(e.target.value)}
              >
                {products.map((pr) => (
                  <option key={pr.id} value={pr.id} className="bg-card">
                    {pr.name} ({pr.plan_code})
                  </option>
                ))}
              </select>
            </div>
            <Button type="submit" disabled={busy || !clientId || !productId}>
              {busy ? "Provisioning…" : "Provisiona"}
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Servizi ({services.length})</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <table className="w-full text-sm">
            <thead className="border-b border-border text-left text-muted-foreground">
              <tr>
                <th className="px-6 py-3 font-medium">Prodotto</th>
                <th className="px-6 py-3 font-medium">Cliente</th>
                <th className="px-6 py-3 font-medium">Backend</th>
                <th className="px-6 py-3 font-medium">Account hosting</th>
                <th className="px-6 py-3 font-medium">Stato</th>
                <th className="px-6 py-3" />
              </tr>
            </thead>
            <tbody>
              {services.map((s) => (
                <tr key={s.id} className="border-b border-border/60 last:border-0">
                  <td className="px-6 py-3 font-medium">{s.product || "—"}</td>
                  <td className="px-6 py-3 text-muted-foreground">{clientName(s.client_id)}</td>
                  <td className="px-6 py-3">
                    <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                      <Server className="h-3.5 w-3.5" />
                      {s.backend}
                    </span>
                  </td>
                  <td className="px-6 py-3 font-mono text-xs text-muted-foreground">
                    {s.hosting_account_id.slice(0, 12)}…
                  </td>
                  <td className="px-6 py-3">
                    <span className={cn("rounded-md px-2 py-0.5 text-xs font-medium capitalize", statusBadge[s.status])}>
                      {s.status}
                    </span>
                  </td>
                  <td className="px-6 py-3 text-right">
                    <Button variant="ghost" size="sm" onClick={() => toggle(s)}>
                      {s.status === "suspended" ? "Riattiva" : "Sospendi"}
                    </Button>
                  </td>
                </tr>
              ))}
              {services.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-6 py-8 text-center text-muted-foreground">
                    Nessun servizio. Provisionane uno sopra.
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
