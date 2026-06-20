"use client";

import { useEffect, useState, type FormEvent } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { StatusBadge } from "@/components/ui/badge";
import { Database, Network, Pencil, Terminal, Trash2, Users, X } from "lucide-react";

import { apiDelete, apiGet, apiPost, apiPut, createDatabase, listDatabases, type DatabaseInstance } from "@/lib/api";
import { PageHeader } from "@/components/page-header";
import { PageTabs, type PageTab } from "@/components/page-tabs";
import { cn } from "@/lib/utils";

const ENGINES = ["postgres", "mysql", "mariadb", "redis", "mongodb"];
const QUERYABLE = ["postgres", "mysql", "mariadb"];
const PRIVILEGES = ["ALL", "SELECT", "INSERT", "UPDATE", "DELETE", "CREATE", "DROP", "ALTER", "INDEX", "EXECUTE", "REFERENCES"];
const selectCls =
  "flex h-9 w-full rounded-md border border-border bg-transparent px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary";

const TABS: PageTab[] = [
  { id: "instances", label: "Instances", icon: Database },
  { id: "users", label: "DB Users", icon: Users },
  { id: "query", label: "SQL Query", icon: Terminal },
  { id: "remote", label: "Remote Access", icon: Network },
];

interface DBUserRow {
  id: string;
  username: string;
  host: string;
  privileges: string[];
  created_at: string;
}

// Toggle-chip privilege selector. "ALL" is exclusive; picking another clears it.
function PrivChips({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  function toggle(p: string) {
    if (p === "ALL") return onChange(["ALL"]);
    const base = value.filter((x) => x !== "ALL");
    const next = base.includes(p) ? base.filter((x) => x !== p) : [...base, p];
    onChange(next.length ? next : ["ALL"]);
  }
  return (
    <div className="flex flex-wrap gap-1.5">
      {PRIVILEGES.map((p) => {
        const on = value.includes(p);
        return (
          <button
            key={p}
            type="button"
            onClick={() => toggle(p)}
            className={cn(
              "rounded-md px-2 py-0.5 text-xs font-medium transition-colors",
              on ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground hover:text-foreground",
            )}
          >
            {p}
          </button>
        );
      })}
    </div>
  );
}

interface QueryResult {
  columns: string[];
  rows: string[][];
  row_count: number;
  truncated: boolean;
}

interface RemoteHost {
  id: string;
  host: string;
}

function fmtSize(mb: number | null) {
  if (mb == null) return "—";
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb} MB`;
}

export default function DatabasesPage() {
  const [dbs, setDbs] = useState<DatabaseInstance[]>([]);
  const [engine, setEngine] = useState("postgres");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [creds, setCreds] = useState<{ user: string; password: string } | null>(null);
  const [queryDbId, setQueryDbId] = useState("");
  const [sql, setSql] = useState("");
  const [queryBusy, setQueryBusy] = useState(false);
  const [queryResult, setQueryResult] = useState<QueryResult | null>(null);
  const [queryError, setQueryError] = useState<string | null>(null);
  const [tables, setTables] = useState<string[]>([]);
  const [remoteDbId, setRemoteDbId] = useState("");
  const [remoteHosts, setRemoteHosts] = useState<RemoteHost[]>([]);
  const [remoteHostInput, setRemoteHostInput] = useState("");
  const [remoteBusy, setRemoteBusy] = useState(false);
  const [editHostId, setEditHostId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [exporting, setExporting] = useState<Record<string, boolean>>({});
  const [tab, setTab] = useState("instances");
  const [userDbId, setUserDbId] = useState("");
  const [dbUsers, setDbUsers] = useState<DBUserRow[]>([]);
  const [uForm, setUForm] = useState<{ username: string; host: string; privileges: string[] }>({
    username: "",
    host: "%",
    privileges: ["ALL"],
  });
  const [uBusy, setUBusy] = useState(false);
  const [newUserPw, setNewUserPw] = useState<string | null>(null);
  const [editUser, setEditUser] = useState<string | null>(null);
  const [editPrivs, setEditPrivs] = useState<string[]>([]);

  async function onExport(dbId: string) {
    setExporting((s) => ({ ...s, [dbId]: true }));
    setError(null);
    setNotice(null);
    try {
      const r = await apiPost<{ storage: string; s3?: string; path: string; size_bytes: number }>(
        `/api/v1/databases/${dbId}/export`,
        {},
      );
      const loc = r.s3 || r.path;
      setNotice(`Export ready (${(r.size_bytes / 1024).toFixed(1)} KB) → ${loc}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Export failed");
    } finally {
      setExporting((s) => ({ ...s, [dbId]: false }));
    }
  }

  async function refresh() {
    try {
      setDbs(await listDatabases());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    }
  }
  useEffect(() => {
    refresh();
  }, []);

  useEffect(() => {
    if (!remoteDbId && pgDbs.length) setRemoteDbId(pgDbs[0].id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dbs]);

  useEffect(() => {
    loadRemoteHosts();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [remoteDbId]);

  useEffect(() => {
    if (!userDbId && pgDbs.length) setUserDbId(pgDbs[0].id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dbs]);

  useEffect(() => {
    loadDBUsers();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userDbId]);

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await createDatabase({ engine, name });
      if (res.credentials) setCreds(res.credentials);
      setName("");
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Create failed");
    } finally {
      setBusy(false);
    }
  }

  const queryableDbs = dbs.filter((d) => QUERYABLE.includes(d.engine));
  const selDb = queryableDbs.find((d) => d.id === (queryDbId || queryableDbs[0]?.id));
  const pgDbs = dbs.filter((d) => ["postgres", "mysql", "mariadb"].includes(d.engine));

  async function loadRemoteHosts() {
    if (!remoteDbId) return;
    try {
      const r = await apiGet<{ hosts: RemoteHost[] }>(`/api/v1/databases/${remoteDbId}/remote-hosts`);
      setRemoteHosts(r.hosts ?? []);
    } catch {
      setRemoteHosts([]);
    }
  }

  function startEditHost(h: RemoteHost) {
    setEditHostId(h.id);
    setRemoteHostInput(h.host);
  }
  function cancelEditHost() {
    setEditHostId(null);
    setRemoteHostInput("");
  }

  async function onAddRemoteHost(e: FormEvent) {
    e.preventDefault();
    setRemoteBusy(true);
    setError(null);
    try {
      if (editHostId) {
        await apiPost(`/api/v1/databases/${remoteDbId}/remote-hosts/${editHostId}`, { host: remoteHostInput.trim() });
        setEditHostId(null);
      } else {
        await apiPost(`/api/v1/databases/${remoteDbId}/remote-hosts`, { host: remoteHostInput.trim() });
      }
      setRemoteHostInput("");
      await loadRemoteHosts();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save host");
    } finally {
      setRemoteBusy(false);
    }
  }

  async function onDeleteRemoteHost(id: string) {
    try {
      await apiDelete(`/api/v1/databases/${remoteDbId}/remote-hosts/${id}`);
      await loadRemoteHosts();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not remove host");
    }
  }

  async function loadTables() {
    if (!selDb) return;
    setQueryError(null);
    const sql =
      selDb.engine === "postgres"
        ? "SELECT table_name FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog','information_schema') ORDER BY table_name"
        : "SELECT table_name FROM information_schema.tables WHERE table_schema = DATABASE() ORDER BY table_name";
    try {
      const r = await apiPost<QueryResult>(`/api/v1/databases/${selDb.id}/query`, { sql });
      setTables(r.rows.map((row) => row[0]).filter(Boolean));
    } catch (e) {
      setQueryError(e instanceof Error ? e.message : "Failed to list tables");
    }
  }

  async function browseTable(name: string) {
    if (!selDb) return;
    const safe = name.replace(/[^a-zA-Z0-9_]/g, "");
    const quoted = selDb.engine === "postgres" ? `"${safe}"` : `\`${safe}\``;
    setQueryBusy(true);
    setQueryError(null);
    setQueryResult(null);
    try {
      const res = await apiPost<QueryResult>(`/api/v1/databases/${selDb.id}/query`, {
        sql: `SELECT * FROM ${quoted} LIMIT 100`,
      });
      setQueryResult(res);
    } catch (e) {
      setQueryError(e instanceof Error ? e.message : "Query failed");
    } finally {
      setQueryBusy(false);
    }
  }

  async function onRunQuery(e: FormEvent) {
    e.preventDefault();
    setQueryBusy(true);
    setQueryError(null);
    setQueryResult(null);
    try {
      const id = queryDbId || queryableDbs[0]?.id;
      if (!id) throw new Error("No queryable database");
      const res = await apiPost<QueryResult>(`/api/v1/databases/${id}/query`, { sql });
      setQueryResult(res);
    } catch (e) {
      setQueryError(e instanceof Error ? e.message : "Query failed");
    } finally {
      setQueryBusy(false);
    }
  }

  async function loadDBUsers() {
    if (!userDbId) return;
    try {
      const r = await apiGet<{ users: DBUserRow[] }>(`/api/v1/databases/${userDbId}/users`);
      setDbUsers(r.users ?? []);
    } catch {
      setDbUsers([]);
    }
  }

  async function onCreateUser(e: FormEvent) {
    e.preventDefault();
    setUBusy(true);
    setError(null);
    setNewUserPw(null);
    try {
      const r = await apiPost<{ password: string }>(`/api/v1/databases/${userDbId}/users`, {
        username: uForm.username.trim(),
        host: uForm.host.trim() || "%",
        privileges: uForm.privileges,
      });
      setNewUserPw(r.password);
      setUForm({ username: "", host: "%", privileges: ["ALL"] });
      await loadDBUsers();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not create user");
    } finally {
      setUBusy(false);
    }
  }

  async function onDeleteUser(uid: string) {
    setError(null);
    try {
      await apiDelete(`/api/v1/databases/${userDbId}/users/${uid}`);
      await loadDBUsers();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not delete user");
    }
  }

  async function onSavePrivileges(uid: string) {
    setError(null);
    try {
      await apiPut(`/api/v1/databases/${userDbId}/users/${uid}/privileges`, { privileges: editPrivs });
      setEditUser(null);
      await loadDBUsers();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not update privileges");
    }
  }

  const userDb = pgDbs.find((d) => d.id === userDbId);
  const userIsMysql = userDb?.engine === "mysql" || userDb?.engine === "mariadb";

  return (
    <div className="space-y-6">
      <PageHeader
        title="Databases"
        description="Provision managed database instances on your nodes (Postgres, MySQL, Redis…)."
      />

      {error && <p className="text-sm text-red-600">{error}</p>}
      {notice && <p className="break-all text-sm text-emerald-600">{notice}</p>}

      {creds && (
        <Card className="border-primary/40">
          <CardHeader>
            <CardTitle className="text-base">Credentials (shown once)</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <pre className="overflow-x-auto rounded-md bg-muted p-3 text-xs">
              user: {creds.user}
              {"\n"}password: {creds.password}
            </pre>
            <Button variant="outline" size="sm" onClick={() => setCreds(null)}>
              Dismiss
            </Button>
          </CardContent>
        </Card>
      )}

      <PageTabs tabs={TABS} active={tab} onChange={setTab} />

      {tab === "instances" && (
        <>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">New database</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={onCreate} className="grid gap-4 sm:grid-cols-4 sm:items-end">
            <div className="space-y-1.5">
              <Label htmlFor="engine">Engine</Label>
              <select
                id="engine"
                value={engine}
                onChange={(e) => setEngine(e.target.value)}
                className="flex h-9 w-full rounded-md border border-border bg-transparent px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              >
                {ENGINES.map((en) => (
                  <option key={en} value={en} className="bg-card">
                    {en}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="dbname">Database name</Label>
              <Input id="dbname" value={name} onChange={(e) => setName(e.target.value)} required />
            </div>
            <Button type="submit" disabled={busy}>
              {busy ? "Creating…" : "Create"}
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Instances ({dbs.length})</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <table className="w-full text-sm">
            <thead className="border-b border-border text-left text-muted-foreground">
              <tr>
                <th className="px-6 py-3 font-medium">Name</th>
                <th className="px-6 py-3 font-medium">Engine</th>
                <th className="px-6 py-3 font-medium">Host</th>
                <th className="px-6 py-3 font-medium">Status</th>
                <th className="px-6 py-3 font-medium">Size</th>
                <th className="px-6 py-3" />
              </tr>
            </thead>
            <tbody>
              {dbs.map((d) => (
                <tr key={d.id} className="border-b border-border/60 last:border-0">
                  <td className="px-6 py-3 font-medium">{d.name}</td>
                  <td className="px-6 py-3 text-muted-foreground">
                    {d.engine}
                    {d.version ? ` ${d.version}` : ""}
                  </td>
                  <td className="px-6 py-3 font-mono text-xs text-muted-foreground">
                    {d.host}:{d.port}
                  </td>
                  <td className="px-6 py-3">
                    <StatusBadge status={d.status} />
                  </td>
                  <td className="px-6 py-3 text-muted-foreground">{fmtSize(d.size_mb)}</td>
                  <td className="px-6 py-3 text-right">
                    {QUERYABLE.includes(d.engine) && (
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={exporting[d.id]}
                        onClick={() => onExport(d.id)}
                      >
                        {exporting[d.id] ? "Exporting…" : "Export"}
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>
        </>
      )}

      {tab === "users" && (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Database users</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Named login users on a database with a specific privilege set. The password is shown
            once and stored only as an envelope-encrypted secret; grants are applied on the node.
          </p>
          {pgDbs.length === 0 ? (
            <p className="text-sm text-muted-foreground">No SQL databases.</p>
          ) : (
            <>
              <div className="flex items-center gap-3">
                <label htmlFor="u-db" className="text-sm text-muted-foreground">
                  Database
                </label>
                <select
                  id="u-db"
                  className={selectCls}
                  value={userDbId}
                  onChange={(e) => setUserDbId(e.target.value)}
                >
                  {pgDbs.map((d) => (
                    <option key={d.id} value={d.id} className="bg-card">
                      {d.name} ({d.engine})
                    </option>
                  ))}
                </select>
              </div>

              {newUserPw && (
                <div className="space-y-2 rounded-md border border-primary/40 bg-primary/5 p-3">
                  <p className="text-xs text-muted-foreground">New user password (shown once):</p>
                  <code className="block break-all font-mono text-sm">{newUserPw}</code>
                  <Button variant="outline" size="sm" onClick={() => setNewUserPw(null)}>
                    Dismiss
                  </Button>
                </div>
              )}

              <form onSubmit={onCreateUser} className="space-y-3 rounded-md border border-border/60 p-3">
                <div className="grid gap-3 sm:grid-cols-3 sm:items-end">
                  <div className="space-y-1.5">
                    <Label htmlFor="u-name">Username</Label>
                    <Input
                      id="u-name"
                      value={uForm.username}
                      onChange={(e) => setUForm({ ...uForm, username: e.target.value })}
                      placeholder="app_user"
                      required
                    />
                  </div>
                  {userIsMysql && (
                    <div className="space-y-1.5">
                      <Label htmlFor="u-host">Host</Label>
                      <Input
                        id="u-host"
                        value={uForm.host}
                        onChange={(e) => setUForm({ ...uForm, host: e.target.value })}
                        placeholder="%"
                        className="font-mono"
                      />
                    </div>
                  )}
                </div>
                <div className="space-y-1.5">
                  <Label>Privileges</Label>
                  <PrivChips value={uForm.privileges} onChange={(v) => setUForm({ ...uForm, privileges: v })} />
                </div>
                <Button type="submit" disabled={uBusy}>
                  {uBusy ? "Creating…" : "Create user"}
                </Button>
              </form>

              {dbUsers.length > 0 && (
                <ul className="divide-y divide-border/60 rounded-md border border-border/60">
                  {dbUsers.map((u) => (
                    <li key={u.id} className="space-y-2 px-4 py-3 text-sm">
                      <div className="flex items-center gap-3">
                        <span className="font-mono">
                          {u.username}
                          {userIsMysql ? `@${u.host}` : ""}
                        </span>
                        {editUser !== u.id && (
                          <div className="flex flex-wrap gap-1">
                            {u.privileges.map((pr) => (
                              <span
                                key={pr}
                                className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground"
                              >
                                {pr}
                              </span>
                            ))}
                          </div>
                        )}
                        <div className="ml-auto flex items-center gap-1">
                          {editUser === u.id ? (
                            <>
                              <Button size="sm" onClick={() => onSavePrivileges(u.id)}>
                                Save
                              </Button>
                              <Button variant="ghost" size="sm" onClick={() => setEditUser(null)}>
                                Cancel
                              </Button>
                            </>
                          ) : (
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => {
                                setEditUser(u.id);
                                setEditPrivs(u.privileges);
                              }}
                            >
                              Edit privileges
                            </Button>
                          )}
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7"
                            onClick={() => onDeleteUser(u.id)}
                            aria-label="Delete user"
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      </div>
                      {editUser === u.id && <PrivChips value={editPrivs} onChange={setEditPrivs} />}
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </CardContent>
      </Card>
      )}

      {tab === "query" && (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">SQL query</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Run a statement against a managed database (Postgres / MySQL). It executes inside the
            database container with a statement timeout; returned rows are capped.
          </p>
          {queryableDbs.length === 0 ? (
            <p className="text-sm text-muted-foreground">No SQL-queryable databases yet.</p>
          ) : (
            <form onSubmit={onRunQuery} className="space-y-3">
              <div className="grid gap-3 sm:grid-cols-3 sm:items-end">
                <div className="space-y-1.5">
                  <Label htmlFor="q-db">Database</Label>
                  <select
                    id="q-db"
                    className={selectCls}
                    value={queryDbId || queryableDbs[0]?.id}
                    onChange={(e) => {
                      setQueryDbId(e.target.value);
                      setTables([]);
                    }}
                  >
                    {queryableDbs.map((d) => (
                      <option key={d.id} value={d.id} className="bg-card">
                        {d.name} ({d.engine})
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <Textarea
                value={sql}
                onChange={(e) => setSql(e.target.value)}
                placeholder="SELECT * FROM users LIMIT 50;"
                className="font-mono"
                required
              />
              <Button type="submit" disabled={queryBusy}>
                {queryBusy ? "Running…" : "Run query"}
              </Button>
            </form>
          )}

          {queryableDbs.length > 0 && (
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <Button type="button" variant="outline" size="sm" onClick={loadTables}>
                  Browse tables
                </Button>
                {tables.length > 0 && (
                  <span className="text-xs text-muted-foreground">{tables.length} tables</span>
                )}
              </div>
              {tables.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {tables.map((t) => (
                    <button
                      key={t}
                      type="button"
                      onClick={() => browseTable(t)}
                      className="rounded bg-muted px-2 py-0.5 font-mono text-xs transition-colors hover:bg-primary/15 hover:text-primary"
                    >
                      {t}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {queryError && <p className="text-sm text-red-600">{queryError}</p>}

          {queryResult && (
            <div className="space-y-2">
              <p className="text-xs text-muted-foreground">
                {queryResult.row_count} row{queryResult.row_count === 1 ? "" : "s"}
                {queryResult.truncated && " (truncated)"}
              </p>
              {queryResult.columns.length > 0 && (
                <div className="overflow-x-auto rounded-md border border-border/60">
                  <table className="w-full text-sm">
                    <thead className="border-b border-border text-left text-muted-foreground">
                      <tr>
                        {queryResult.columns.map((c) => (
                          <th key={c} className="px-3 py-2 font-medium">
                            {c}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {queryResult.rows.map((row, i) => (
                        <tr key={i} className="border-b border-border/60 last:border-0">
                          {row.map((cell, j) => (
                            <td key={j} className="px-3 py-2 font-mono text-xs">
                              {cell}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>
      )}

      {tab === "remote" && (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Remote access</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Allow external hosts to connect to a database (by IP or CIDR). Postgres rules render
            into <code>pg_hba.conf</code>; MySQL/MariaDB render host-scoped grants.
          </p>
          {pgDbs.length === 0 ? (
            <p className="text-sm text-muted-foreground">No SQL databases.</p>
          ) : (
            <>
              <div className="flex items-center gap-3">
                <label htmlFor="rh-db" className="text-sm text-muted-foreground">
                  Database
                </label>
                <select
                  id="rh-db"
                  className={selectCls}
                  value={remoteDbId}
                  onChange={(e) => setRemoteDbId(e.target.value)}
                >
                  {pgDbs.map((d) => (
                    <option key={d.id} value={d.id} className="bg-card">
                      {d.name}
                    </option>
                  ))}
                </select>
              </div>
              <form onSubmit={onAddRemoteHost} className="flex items-end gap-3">
                <div className="grow space-y-1.5">
                  <Label htmlFor="rh-host">Host (IP or CIDR)</Label>
                  <Input
                    id="rh-host"
                    value={remoteHostInput}
                    onChange={(e) => setRemoteHostInput(e.target.value)}
                    placeholder="203.0.113.0/24"
                    required
                  />
                </div>
                <Button type="submit" disabled={remoteBusy}>
                  {remoteBusy ? "Saving…" : editHostId ? "Save host" : "Allow host"}
                </Button>
                {editHostId && (
                  <Button type="button" variant="ghost" size="icon" onClick={cancelEditHost} aria-label="Cancel">
                    <X className="h-4 w-4" />
                  </Button>
                )}
              </form>
              {remoteHosts.length > 0 && (
                <ul className="divide-y divide-border/60 rounded-md border border-border/60">
                  {remoteHosts.map((h) => (
                    <li key={h.id} className="flex items-center gap-3 px-4 py-2 text-sm">
                      <span className="font-mono">{h.host}</span>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="ml-auto h-7 w-7"
                        onClick={() => startEditHost(h)}
                        aria-label="Edit host"
                      >
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7"
                        onClick={() => onDeleteRemoteHost(h.id)}
                        aria-label="Remove host"
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </CardContent>
      </Card>
      )}
    </div>
  );
}
