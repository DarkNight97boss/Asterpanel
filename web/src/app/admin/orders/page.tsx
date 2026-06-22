"use client";

import { useEffect, useState, type FormEvent } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { apiGet, apiPost } from "@/lib/api";

interface Order {
  id: string;
  client_id: string;
  product_name: string;
  total_cents: number;
  status: string;
  created_at: string;
}
interface Client {
  id: string;
  name: string;
}
interface Product {
  id: string;
  name: string;
  price_cents: number;
}

const euro = (cents: number) => `€${(cents / 100).toLocaleString("it-IT")}`;
const statusBadge: Record<string, string> = {
  active: "bg-emerald-500/15 text-emerald-600",
  cancelled: "bg-muted text-muted-foreground",
};

export default function OrdersPage() {
  const [orders, setOrders] = useState<Order[]>([]);
  const [clients, setClients] = useState<Client[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [clientId, setClientId] = useState("");
  const [productId, setProductId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function load() {
    try {
      const [o, c, p] = await Promise.all([
        apiGet<{ orders: Order[] }>("/api/billing/orders"),
        apiGet<{ clients: Client[] }>("/api/billing/clients"),
        apiGet<{ products: Product[] }>("/api/billing/products"),
      ]);
      setOrders(o.orders ?? []);
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

  async function place(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await apiPost<{ temp_password?: string }>("/api/billing/orders", {
        client_id: clientId,
        product_id: productId,
      });
      setNotice(
        res.temp_password
          ? `Ordine evaso: servizio provisionato e fattura emessa. Password una-tantum: ${res.temp_password}`
          : "Ordine evaso.",
      );
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Ordine non riuscito");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-medium">Ordini</h1>
        <p className="text-sm text-muted-foreground">
          Un ordine provisiona il servizio (via il modulo hosting) ed emette la prima fattura.
        </p>
      </div>
      {error && <p className="text-sm text-red-600">{error}</p>}
      {notice && <p className="text-sm text-emerald-600">{notice}</p>}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Nuovo ordine</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={place} className="flex flex-wrap items-end gap-3">
            <div className="space-y-1">
              <Label htmlFor="client">Cliente</Label>
              <select
                id="client"
                className="flex h-9 w-44 rounded-md border border-border bg-transparent px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                value={clientId}
                onChange={(e) => setClientId(e.target.value)}
              >
                {clients.map((c) => (
                  <option key={c.id} value={c.id} className="bg-card">{c.name}</option>
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
                {products.map((p) => (
                  <option key={p.id} value={p.id} className="bg-card">
                    {p.name} — {euro(p.price_cents)}
                  </option>
                ))}
              </select>
            </div>
            <Button type="submit" disabled={busy || !clientId || !productId}>
              {busy ? "Elaborazione…" : "Evadi ordine"}
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Ordini ({orders.length})</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <table className="w-full text-sm">
            <thead className="border-b border-border text-left text-muted-foreground">
              <tr>
                <th className="px-6 py-3 font-medium">Prodotto</th>
                <th className="px-6 py-3 font-medium">Cliente</th>
                <th className="px-6 py-3 font-medium">Totale</th>
                <th className="px-6 py-3 font-medium">Data</th>
                <th className="px-6 py-3 font-medium">Stato</th>
              </tr>
            </thead>
            <tbody>
              {orders.map((o) => (
                <tr key={o.id} className="border-b border-border/60 last:border-0">
                  <td className="px-6 py-3 font-medium">{o.product_name}</td>
                  <td className="px-6 py-3 text-muted-foreground">{clientName(o.client_id)}</td>
                  <td className="px-6 py-3 text-muted-foreground">{euro(o.total_cents)}</td>
                  <td className="px-6 py-3 text-muted-foreground">
                    {new Date(o.created_at).toLocaleDateString("it-IT")}
                  </td>
                  <td className="px-6 py-3">
                    <span className={cn("rounded-md px-2 py-0.5 text-xs font-medium capitalize", statusBadge[o.status])}>
                      {o.status === "active" ? "evaso" : o.status}
                    </span>
                  </td>
                </tr>
              ))}
              {orders.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-6 py-8 text-center text-muted-foreground">
                    Nessun ordine.
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
