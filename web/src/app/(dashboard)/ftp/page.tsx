"use client";

import { useEffect, useState, type FormEvent } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { StatusBadge } from "@/components/ui/badge";
import { createFtpAccount, listFtpAccounts, type FtpAccount } from "@/lib/api";

const PROTOCOLS = ["SFTP", "FTPS"];

export default function FtpPage() {
  const [accounts, setAccounts] = useState<FtpAccount[]>([]);
  const [username, setUsername] = useState("");
  const [protocol, setProtocol] = useState("SFTP");
  const [home, setHome] = useState("/sites/");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [password, setPassword] = useState<string | null>(null);

  async function refresh() {
    try {
      setAccounts(await listFtpAccounts());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    }
  }
  useEffect(() => {
    refresh();
  }, []);

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await createFtpAccount({ username, protocol, home_directory: home });
      if (res.password) setPassword(res.password);
      setUsername("");
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Create failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">FTP / SFTP</h1>
        <p className="text-sm text-muted-foreground">
          Chrooted SFTP/FTPS accounts scoped to a site directory. Keys or passwords, never shared.
        </p>
      </header>

      {error && <p className="text-sm text-red-400">{error}</p>}

      {password && (
        <Card className="border-primary/40">
          <CardHeader>
            <CardTitle className="text-base">Password (shown once)</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <pre className="overflow-x-auto rounded-md bg-muted p-3 text-xs">{password}</pre>
            <Button variant="outline" size="sm" onClick={() => setPassword(null)}>
              Dismiss
            </Button>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">New account</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={onCreate} className="grid gap-4 sm:grid-cols-4 sm:items-end">
            <div className="space-y-1.5">
              <Label htmlFor="username">Username</Label>
              <Input id="username" value={username} onChange={(e) => setUsername(e.target.value)} required />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="protocol">Protocol</Label>
              <select
                id="protocol"
                value={protocol}
                onChange={(e) => setProtocol(e.target.value)}
                className="flex h-9 w-full rounded-md border border-border bg-transparent px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              >
                {PROTOCOLS.map((p) => (
                  <option key={p} value={p} className="bg-card">
                    {p}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="home">Home directory</Label>
              <Input id="home" value={home} onChange={(e) => setHome(e.target.value)} required />
            </div>
            <Button type="submit" disabled={busy}>
              {busy ? "Creating…" : "Create"}
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Accounts ({accounts.length})</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <table className="w-full text-sm">
            <thead className="border-b border-border text-left text-muted-foreground">
              <tr>
                <th className="px-6 py-3 font-medium">Username</th>
                <th className="px-6 py-3 font-medium">Protocol</th>
                <th className="px-6 py-3 font-medium">Home</th>
                <th className="px-6 py-3 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {accounts.map((a) => (
                <tr key={a.id} className="border-b border-border/60 last:border-0">
                  <td className="px-6 py-3 font-medium">{a.username}</td>
                  <td className="px-6 py-3">
                    <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{a.protocol}</span>
                  </td>
                  <td className="px-6 py-3 font-mono text-xs text-muted-foreground">{a.home_directory}</td>
                  <td className="px-6 py-3">
                    <StatusBadge status={a.status} />
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
