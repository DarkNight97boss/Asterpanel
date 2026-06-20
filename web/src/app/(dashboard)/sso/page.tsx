"use client";

import { useEffect, useState, type FormEvent } from "react";
import { Copy, Plus, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { apiDelete, apiGet, apiPost } from "@/lib/api";
import { PageHeader } from "@/components/page-header";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8080";

interface Provider {
  id: string;
  name: string;
  issuer: string;
  client_id: string;
  allowed_domains: string;
  enabled: boolean;
  created_at: string;
}

function callbackURL(id: string) {
  return `${API_URL}/api/v1/auth/sso/${id}/callback`;
}

export default function SSOPage() {
  const [providers, setProviders] = useState<Provider[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [issuer, setIssuer] = useState("");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [allowedDomains, setAllowedDomains] = useState("");
  const [busy, setBusy] = useState(false);

  async function load() {
    try {
      const r = await apiGet<{ providers: Provider[] }>("/api/v1/sso/providers");
      setProviders(r.providers ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load providers");
    }
  }
  useEffect(() => {
    load();
  }, []);

  async function create(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await apiPost("/api/v1/sso/providers", {
        name: name.trim(),
        issuer: issuer.trim(),
        client_id: clientId.trim(),
        client_secret: clientSecret,
        allowed_domains: allowedDomains.trim(),
      });
      setName("");
      setIssuer("");
      setClientId("");
      setClientSecret("");
      setAllowedDomains("");
      setNotice("Provider added. Register the callback URL below at your IdP.");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not add provider");
    } finally {
      setBusy(false);
    }
  }

  async function del(id: string) {
    setError(null);
    try {
      await apiDelete(`/api/v1/sso/providers/${id}`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not delete provider");
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Single Sign-On"
        description="Let users sign in with an external OpenID Connect identity provider (Google Workspace, Okta, Entra ID, Keycloak…). The panel validates the IdP's signed ID token before creating a session; the client secret is encrypted at rest."
      />

      {error && <p className="text-sm text-red-600">{error}</p>}
      {notice && <p className="text-sm text-emerald-600">{notice}</p>}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Add OIDC provider</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={create} className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="sso-name">Display name</Label>
                <Input
                  id="sso-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Google Workspace"
                  required
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="sso-issuer">Issuer URL</Label>
                <Input
                  id="sso-issuer"
                  value={issuer}
                  onChange={(e) => setIssuer(e.target.value)}
                  placeholder="https://accounts.google.com"
                  className="font-mono"
                  required
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="sso-client">Client ID</Label>
                <Input
                  id="sso-client"
                  value={clientId}
                  onChange={(e) => setClientId(e.target.value)}
                  className="font-mono"
                  required
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="sso-secret">Client secret</Label>
                <Input
                  id="sso-secret"
                  type="password"
                  value={clientSecret}
                  onChange={(e) => setClientSecret(e.target.value)}
                  className="font-mono"
                  required
                />
              </div>
              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="sso-domains">Allowed email domains</Label>
                <Input
                  id="sso-domains"
                  value={allowedDomains}
                  onChange={(e) => setAllowedDomains(e.target.value)}
                  placeholder="acme.com, acme.io  (blank = any verified email)"
                  className="font-mono"
                />
              </div>
            </div>
            <Button type="submit" disabled={busy}>
              <Plus className="h-4 w-4" />
              {busy ? "Adding…" : "Add provider"}
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Providers ({providers.length})</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {providers.length === 0 && (
            <p className="text-sm text-muted-foreground">No SSO providers configured.</p>
          )}
          {providers.map((p) => (
            <div key={p.id} className="space-y-3 rounded-md border border-border/60 p-4">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{p.name}</span>
                <span
                  className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                    p.enabled
                      ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
                      : "bg-muted text-muted-foreground"
                  }`}
                >
                  {p.enabled ? "enabled" : "disabled"}
                </span>
                <span className="font-mono text-xs text-muted-foreground">{p.issuer}</span>
                <Button variant="ghost" size="sm" className="ml-auto" onClick={() => del(p.id)}>
                  <Trash2 className="h-4 w-4" />
                  Remove
                </Button>
              </div>
              <div className="grid gap-1 text-xs text-muted-foreground sm:grid-cols-2">
                <div>
                  Client ID: <span className="font-mono">{p.client_id}</span>
                </div>
                <div>
                  Allowed domains: <span className="font-mono">{p.allowed_domains || "any"}</span>
                </div>
              </div>
              <div className="space-y-1.5">
                <Label>Redirect / callback URL (register this at your IdP)</Label>
                <div className="flex items-center gap-2">
                  <code className="flex-1 truncate rounded-md bg-muted px-3 py-2 font-mono text-xs">
                    {callbackURL(p.id)}
                  </code>
                  <Button
                    variant="outline"
                    size="icon"
                    onClick={() => navigator.clipboard?.writeText(callbackURL(p.id))}
                    aria-label="Copy callback URL"
                  >
                    <Copy className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
