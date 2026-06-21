"use client";

import { useEffect, useState, type FormEvent } from "react";
import { Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { apiGet, apiPost, apiDelete } from "@/lib/api";

interface Product {
  id: string;
  name: string;
  plan_code: string;
  price_cents: number;
  cycle: string;
}

const euro = (cents: number) => `€${(cents / 100).toLocaleString("it-IT")}`;

export default function ProductsPage() {
  const [products, setProducts] = useState<Product[]>([]);
  const [name, setName] = useState("");
  const [planCode, setPlanCode] = useState("free");
  const [price, setPrice] = useState("0");
  const [cycle, setCycle] = useState("monthly");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    try {
      const { products } = await apiGet<{ products: Product[] }>("/api/billing/products");
      setProducts(products ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Errore di caricamento");
    }
  }
  useEffect(() => {
    load();
  }, []);

  async function create(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await apiPost("/api/billing/products", {
        name: name.trim(),
        plan_code: planCode.trim(),
        price_cents: Math.round(parseFloat(price || "0") * 100),
        cycle,
      });
      setName("");
      setPrice("0");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Impossibile creare il prodotto");
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    setError(null);
    try {
      await apiDelete(`/api/billing/products/${id}`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Impossibile eliminare");
    }
  }

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-medium">Prodotti</h1>
        <p className="text-sm text-muted-foreground">
          Il catalogo: ogni prodotto mappa un pacchetto del backend hosting (plan code).
        </p>
      </div>
      {error && <p className="text-sm text-red-600">{error}</p>}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Nuovo prodotto</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={create} className="flex flex-wrap items-end gap-3">
            <div className="grow space-y-1">
              <Label htmlFor="name">Nome</Label>
              <Input id="name" value={name} onChange={(e) => setName(e.target.value)} required />
            </div>
            <div className="space-y-1">
              <Label htmlFor="plan">Plan code</Label>
              <Input id="plan" className="w-28" value={planCode} onChange={(e) => setPlanCode(e.target.value)} required />
            </div>
            <div className="space-y-1">
              <Label htmlFor="price">Prezzo €</Label>
              <Input id="price" type="number" min={0} step="0.01" className="w-24" value={price} onChange={(e) => setPrice(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="cycle">Ciclo</Label>
              <select
                id="cycle"
                className="flex h-9 w-28 rounded-md border border-border bg-transparent px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                value={cycle}
                onChange={(e) => setCycle(e.target.value)}
              >
                <option value="monthly" className="bg-card">mensile</option>
                <option value="yearly" className="bg-card">annuale</option>
              </select>
            </div>
            <Button type="submit" disabled={busy}>
              {busy ? "Salvataggio…" : "Aggiungi"}
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Catalogo ({products.length})</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <table className="w-full text-sm">
            <thead className="border-b border-border text-left text-muted-foreground">
              <tr>
                <th className="px-6 py-3 font-medium">Nome</th>
                <th className="px-6 py-3 font-medium">Plan code</th>
                <th className="px-6 py-3 font-medium">Prezzo</th>
                <th className="px-6 py-3 font-medium">Ciclo</th>
                <th className="px-6 py-3" />
              </tr>
            </thead>
            <tbody>
              {products.map((pr) => (
                <tr key={pr.id} className="border-b border-border/60 last:border-0">
                  <td className="px-6 py-3 font-medium">{pr.name}</td>
                  <td className="px-6 py-3 font-mono text-xs text-muted-foreground">{pr.plan_code}</td>
                  <td className="px-6 py-3 text-muted-foreground">{euro(pr.price_cents)}</td>
                  <td className="px-6 py-3 text-muted-foreground">{pr.cycle === "yearly" ? "annuale" : "mensile"}</td>
                  <td className="px-6 py-3 text-right">
                    <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => remove(pr.id)} aria-label="Elimina prodotto">
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </td>
                </tr>
              ))}
              {products.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-6 py-8 text-center text-muted-foreground">
                    Nessun prodotto. Aggiungine uno sopra.
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
