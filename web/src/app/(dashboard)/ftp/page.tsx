"use client";

import { useEffect, useState, type FormEvent } from "react";
import { Check, HardDrive, KeyRound, Pencil, Trash2, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { StatusBadge } from "@/components/ui/badge";
import { apiDelete, apiGet, apiPost, createFtpAccount, listFtpAccounts, type FtpAccount } from "@/lib/api";
import { PageHeader } from "@/components/page-header";
import { PageTabs, type PageTab } from "@/components/page-tabs";

const PROTOCOLS = ["SFTP", "FTPS"];

interface SSHKey {
  id: string;
  name: string;
  key_type: string;
  fingerprint: string;
  created_at: string;
}

const TABS: PageTab[] = [
  { id: "accounts", label: "Accounts", icon: HardDrive },
  { id: "ssh", label: "SSH Keys", icon: KeyRound },
];

export default function FtpPage() {
  const [accounts, setAccounts] = useState<FtpAccount[]>([]);
  const [username, setUsername] = useState("");
  const [protocol, setProtocol] = useState("SFTP");
  const [home, setHome] = useState("/sites/");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [password, setPassword] = useState<string | null>(null);
  const [tab, setTab] = useState("accounts");
  const [sshKeys, setSshKeys] = useState<SSHKey[]>([]);
  const [editKeyId, setEditKeyId] = useState<string | null>(null);
  const [editKeyName, setEditKeyName] = useState("");
  const [keyName, setKeyName] = useState("");
  const [keyValue, setKeyValue] = useState("");
  const [keyBusy, setKeyBusy] = useState(false);

  async function refresh() {
    try {
      setAccounts(await listFtpAccounts());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    }
  }
  async function loadKeys() {
    try {
      const { keys } = await apiGet<{ keys: SSHKey[] }>("/api/v1/ssh-keys");
      setSshKeys(keys ?? []);
    } catch {
      /* ignore */
    }
  }
  useEffect(() => {
    refresh();
    loadKeys();
  }, []);

  async function onAddKey(e: FormEvent) {
    e.preventDefault();
    setKeyBusy(true);
    setError(null);
    try {
      await apiPost("/api/v1/ssh-keys", { name: keyName.trim(), public_key: keyValue.trim() });
      setKeyName("");
      setKeyValue("");
      await loadKeys();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not add key");
    } finally {
      setKeyBusy(false);
    }
  }

  async function onDeleteKey(keyId: string) {
    setError(null);
    try {
      await apiDelete(`/api/v1/ssh-keys/${keyId}`);
      await loadKeys();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not delete key");
    }
  }

  async function saveKeyName(keyId: string) {
    setError(null);
    try {
      await apiPost(`/api/v1/ssh-keys/${keyId}`, { name: editKeyName.trim() });
      setEditKeyId(null);
      await loadKeys();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not rename key");
    }
  }

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
      <PageHeader title={"FTP / SFTP"} description={"Chrooted SFTP/FTPS accounts scoped to a site directory. Keys or passwords, never shared."} />

      {error && <p className="text-sm text-red-600">{error}</p>}

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

      <PageTabs tabs={TABS} active={tab} onChange={setTab} />

      {tab === "accounts" && (
        <>
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
        </>
      )}

      {tab === "ssh" && (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">SSH keys ({sshKeys.length})</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Authorized public keys for SSH/SFTP access. Paste an OpenSSH public key — only the
            public half. Keys are written to the account&apos;s authorized_keys on the node.
          </p>
          <form onSubmit={onAddKey} className="space-y-3">
            <div className="space-y-1.5 sm:max-w-xs">
              <Label htmlFor="key-name">Label</Label>
              <Input id="key-name" value={keyName} onChange={(e) => setKeyName(e.target.value)} placeholder="laptop" required />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="key-value">Public key</Label>
              <Textarea
                id="key-value"
                value={keyValue}
                onChange={(e) => setKeyValue(e.target.value)}
                placeholder="ssh-ed25519 AAAA… user@host"
                className="font-mono"
                rows={3}
                required
              />
            </div>
            <Button type="submit" disabled={keyBusy}>
              {keyBusy ? "Adding…" : "Authorize key"}
            </Button>
          </form>

          {sshKeys.length > 0 && (
            <ul className="divide-y divide-border/60 rounded-md border border-border/60">
              {sshKeys.map((k) => (
                <li key={k.id} className="flex items-center gap-3 px-4 py-2.5 text-sm">
                  <KeyRound className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 grow">
                    {editKeyId === k.id ? (
                      <Input
                        value={editKeyName}
                        onChange={(e) => setEditKeyName(e.target.value)}
                        className="h-8"
                        autoFocus
                      />
                    ) : (
                      <div className="font-medium">{k.name}</div>
                    )}
                    <div className="truncate font-mono text-xs text-muted-foreground">
                      <span className="rounded bg-muted px-1 py-0.5">{k.key_type}</span> {k.fingerprint}
                    </div>
                  </div>
                  {editKeyId === k.id ? (
                    <>
                      <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => saveKeyName(k.id)} aria-label="Save name">
                        <Check className="h-4 w-4 text-emerald-500" />
                      </Button>
                      <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setEditKeyId(null)} aria-label="Cancel">
                        <X className="h-4 w-4" />
                      </Button>
                    </>
                  ) : (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7"
                      onClick={() => {
                        setEditKeyId(k.id);
                        setEditKeyName(k.name);
                      }}
                      aria-label="Rename key"
                    >
                      <Pencil className="h-4 w-4" />
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7"
                    onClick={() => onDeleteKey(k.id)}
                    aria-label="Remove key"
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
      )}
    </div>
  );
}
