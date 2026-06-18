"use client";

import { useEffect, useState, type FormEvent } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { StatusBadge } from "@/components/ui/badge";
import { Trash2 } from "lucide-react";

import { apiDelete, apiGet, apiPost, createDatabase, listDatabases, type DatabaseInstance } from "@/lib/api";
import { PageHeader } from "@/components/page-header";

const ENGINES = ["postgres", "mysql", "mariadb", "redis", "mongodb"];
const QUERYABLE = ["postgres", "mysql", "mariadb"];
const selectCls =
  "flex h-9 w-full rounded-md border border-border bg-transparent px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary";

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
  const [notice, setNotice] = useState<string | null>(null);
  const [exporting, setExporting] = useState<Record<string, boolean>>({});

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
  const pgDbs = dbs.filter((d) => d.engine === "postgres");

  async function loadRemoteHosts() {
    if (!remoteDbId) return;
    try {
      const r = await apiGet<{ hosts: RemoteHost[] }>(`/api/v1/databases/${remoteDbId}/remote-hosts`);
      setRemoteHosts(r.hosts ?? []);
    } catch {
      setRemoteHosts([]);
    }
  }

  async function onAddRemoteHost(e: FormEvent) {
    e.preventDefault();
    setRemoteBusy(true);
    setError(null);
    try {
      await apiPost(`/api/v1/databases/${remoteDbId}/remote-hosts`, { host: remoteHostInput.trim() });
      setRemoteHostInput("");
      await loadRemoteHosts();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not add host");
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

  return (
    <div className="space-y-6">
      <PageHeader
        title="Databases"
        description="Provision managed database instances on your nodes (Postgres, MySQL, Redis…)."
      />

      {error && <p className="text-sm text-red-400">{error}</p>}
      {notice && <p className="break-all text-sm text-emerald-400">{notice}</p>}

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

          {queryError && <p className="text-sm text-red-400">{queryError}</p>}

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

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Remote access</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Allow external hosts to connect to a Postgres database (by IP or CIDR). Rules are
            rendered into the database&apos;s <code>pg_hba.conf</code>.
          </p>
          {pgDbs.length === 0 ? (
            <p className="text-sm text-muted-foreground">No Postgres databases.</p>
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
                  {remoteBusy ? "Adding…" : "Allow host"}
                </Button>
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
    </div>
  );
}
