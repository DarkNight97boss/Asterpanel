"use client";

import { useEffect, useState, type FormEvent } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { StatusBadge } from "@/components/ui/badge";
import { apiPost, createDatabase, listDatabases, type DatabaseInstance } from "@/lib/api";

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
      <header>
        <h1 className="text-2xl font-semibold">Databases</h1>
        <p className="text-sm text-muted-foreground">
          Provision managed database instances on your nodes (Postgres, MySQL, Redis…).
        </p>
      </header>

      {error && <p className="text-sm text-red-400">{error}</p>}

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
                    onChange={(e) => setQueryDbId(e.target.value)}
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
    </div>
  );
}
