"use client";

import { useEffect, useState, type FormEvent } from "react";
import { ShieldCheck } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { apiPut } from "@/lib/api";
import { useBranding, type Branding } from "@/lib/branding";
import { Feature, ProGate } from "@/lib/license";

export default function BrandingPage() {
  const { branding, setBranding } = useBranding();
  const [form, setForm] = useState<Branding>(branding);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setForm(branding);
  }, [branding]);

  function up<K extends keyof Branding>(key: K, value: Branding[K]) {
    setForm((f) => ({ ...f, [key]: value }));
    setSaved(false);
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await apiPut<{ branding: Branding }>("/api/v1/branding", form);
      setBranding(res.branding); // applies live (theme + title)
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save branding");
    } finally {
      setBusy(false);
    }
  }

  return (
    <ProGate feature={Feature.WhiteLabel}>
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">Branding</h1>
        <p className="text-sm text-muted-foreground">
          White-label the panel for your organization. Sub-accounts inherit your brand unless they
          set their own.
        </p>
      </header>

      {error && <p className="text-sm text-red-600">{error}</p>}
      {saved && <p className="text-sm text-emerald-600">Branding saved and applied.</p>}

      <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Customize</CardTitle>
          </CardHeader>
          <CardContent>
            <form onSubmit={save} className="space-y-4">
              <div className="space-y-1">
                <Label htmlFor="panel_name">Panel name</Label>
                <Input
                  id="panel_name"
                  value={form.panel_name}
                  onChange={(e) => up("panel_name", e.target.value)}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="logo_url">Logo URL</Label>
                <Input
                  id="logo_url"
                  placeholder="https://…/logo.svg"
                  value={form.logo_url}
                  onChange={(e) => up("logo_url", e.target.value)}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="primary_color">Primary color</Label>
                <div className="flex items-center gap-2">
                  <input
                    type="color"
                    aria-label="Primary color"
                    value={form.primary_color}
                    onChange={(e) => up("primary_color", e.target.value)}
                    className="h-9 w-12 cursor-pointer rounded border border-input bg-background"
                  />
                  <Input
                    id="primary_color"
                    value={form.primary_color}
                    onChange={(e) => up("primary_color", e.target.value)}
                    className="font-mono"
                  />
                </div>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1">
                  <Label htmlFor="support_email">Support email</Label>
                  <Input
                    id="support_email"
                    type="email"
                    value={form.support_email}
                    onChange={(e) => up("support_email", e.target.value)}
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="support_url">Support URL</Label>
                  <Input
                    id="support_url"
                    value={form.support_url}
                    onChange={(e) => up("support_url", e.target.value)}
                  />
                </div>
              </div>
              <Button type="submit" disabled={busy}>
                Save &amp; apply
              </Button>
            </form>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Preview</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center gap-2 rounded-md border border-border px-3 py-2.5">
              {form.logo_url ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={form.logo_url} alt="" className="h-5 w-5 rounded object-contain" />
              ) : (
                <ShieldCheck className="h-5 w-5" style={{ color: form.primary_color }} />
              )}
              <span className="truncate font-semibold">{form.panel_name || "AsterPanel"}</span>
            </div>
            <button
              type="button"
              className="w-full rounded-md px-3 py-2 text-sm font-medium text-white"
              style={{ backgroundColor: form.primary_color }}
            >
              Primary button
            </button>
            <p className="text-xs text-muted-foreground">
              {form.support_email || form.support_url
                ? `Support: ${form.support_email || form.support_url}`
                : "No support contact set."}
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
    </ProGate>
  );
}
