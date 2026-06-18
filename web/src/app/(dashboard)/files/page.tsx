"use client";

import { useCallback, useEffect, useRef, useState, type ChangeEvent } from "react";
import {
  File,
  Folder,
  FolderPlus,
  FilePlus,
  Upload,
  Trash2,
  X,
  Save,
  ShieldCheck,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { apiDelete, apiGet, apiPost, apiPut, listWebsites, type Website } from "@/lib/api";

interface Entry {
  name: string;
  type: "dir" | "file";
  size: number | null;
  modified: number;
}

interface FileContent {
  path: string;
  content: string;
  encoding: "utf8" | "base64" | "none";
  size: number;
  truncated: boolean;
}

interface ScanResult {
  engine_available: boolean;
  clean: boolean;
  scanned_path: string;
  infected: { file: string; signature: string }[];
}

function fmt(size: number | null) {
  if (size == null) return "—";
  const u = ["B", "KB", "MB", "GB"];
  let i = 0;
  let n = size;
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(n < 10 && i > 0 ? 1 : 0)} ${u[i]}`;
}

function join(dir: string, name: string) {
  return dir === "/" ? `/${name}` : `${dir}/${name}`;
}

async function fileToBase64(file: globalThis.File): Promise<string> {
  const buf = new Uint8Array(await file.arrayBuffer());
  let bin = "";
  for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]);
  return btoa(bin);
}

export default function FilesPage() {
  const [sites, setSites] = useState<Website[]>([]);
  const [siteId, setSiteId] = useState<string>("");
  const [path, setPath] = useState("/");
  const [entries, setEntries] = useState<Entry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [viewer, setViewer] = useState<FileContent | null>(null);
  const [draft, setDraft] = useState("");
  const [scan, setScan] = useState<ScanResult | null>(null);
  const [scanning, setScanning] = useState(false);
  const uploadRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    listWebsites()
      .then((ws) => {
        setSites(ws);
        if (ws.length) setSiteId(ws[0].id);
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Failed to load sites"));
  }, []);

  const base = siteId ? `/api/v1/sites/${siteId}/files` : "";

  const load = useCallback(
    async (p: string) => {
      if (!siteId) return;
      setError(null);
      try {
        const res = await apiGet<{ path: string; entries: Entry[] }>(
          `${base}?path=${encodeURIComponent(p)}`,
        );
        setEntries(res.entries ?? []);
      } catch (e) {
        setEntries([]);
        setError(e instanceof Error ? e.message : "Failed to load");
      }
    },
    [siteId, base],
  );

  useEffect(() => {
    if (siteId) load(path);
  }, [siteId, path, load]);

  const segments = path === "/" ? [] : path.slice(1).split("/");

  async function openEntry(entry: Entry) {
    if (entry.type === "dir") {
      setPath(join(path, entry.name));
      return;
    }
    setError(null);
    try {
      const fc = await apiGet<FileContent>(
        `${base}/content?path=${encodeURIComponent(join(path, entry.name))}`,
      );
      setViewer(fc);
      setDraft(fc.encoding === "utf8" ? fc.content : "");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to open file");
    }
  }

  async function saveFile() {
    if (!viewer) return;
    setBusy(true);
    setError(null);
    try {
      await apiPut(`${base}/content`, { path: viewer.path, content: draft, encoding: "utf8" });
      setViewer(null);
      await load(path);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setBusy(false);
    }
  }

  async function createFolder() {
    const name = window.prompt("New folder name");
    if (!name) return;
    setBusy(true);
    setError(null);
    try {
      await apiPost(`${base}/dir`, { path: join(path, name) });
      await load(path);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create folder");
    } finally {
      setBusy(false);
    }
  }

  async function createFile() {
    const name = window.prompt("New file name");
    if (!name) return;
    setBusy(true);
    setError(null);
    try {
      await apiPut(`${base}/content`, { path: join(path, name), content: "", encoding: "utf8" });
      await load(path);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create file");
    } finally {
      setBusy(false);
    }
  }

  async function onUpload(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) {
      setBusy(true);
      setError(null);
      try {
        const content = await fileToBase64(file);
        await apiPut(`${base}/content`, {
          path: join(path, file.name),
          content,
          encoding: "base64",
        });
        await load(path);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Upload failed");
      } finally {
        setBusy(false);
      }
    }
    if (uploadRef.current) uploadRef.current.value = "";
  }

  async function runScan() {
    setScanning(true);
    setError(null);
    setScan(null);
    try {
      const res = await apiPost<ScanResult>(`${base}/scan`, { path });
      setScan(res);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Scan failed");
    } finally {
      setScanning(false);
    }
  }

  async function remove(entry: Entry) {
    if (!window.confirm(`Delete ${entry.name}? This cannot be undone.`)) return;
    setBusy(true);
    setError(null);
    try {
      await apiDelete(`${base}?path=${encodeURIComponent(join(path, entry.name))}`);
      await load(path);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to delete");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">File Manager</h1>
          <p className="text-sm text-muted-foreground">
            Browse and manage files inside a site&apos;s document root.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={siteId}
            onChange={(e) => {
              setSiteId(e.target.value);
              setPath("/");
            }}
            className="h-9 rounded-md border border-input bg-background px-3 text-sm"
          >
            {sites.length === 0 && <option value="">No sites</option>}
            {sites.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
          <Button variant="outline" size="sm" disabled={!siteId || busy} onClick={createFolder}>
            <FolderPlus className="h-4 w-4" />
            Folder
          </Button>
          <Button variant="outline" size="sm" disabled={!siteId || busy} onClick={createFile}>
            <FilePlus className="h-4 w-4" />
            File
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={!siteId || busy}
            onClick={() => uploadRef.current?.click()}
          >
            <Upload className="h-4 w-4" />
            Upload
          </Button>
          <Button variant="outline" size="sm" disabled={!siteId || scanning} onClick={runScan}>
            <ShieldCheck className={scanning ? "h-4 w-4 animate-pulse" : "h-4 w-4"} />
            Scan
          </Button>
          <input ref={uploadRef} type="file" hidden onChange={onUpload} />
        </div>
      </header>

      {error && <p className="text-sm text-red-600">{error}</p>}

      {scan && (
        <div
          className={cn(
            "rounded-md border px-4 py-2 text-sm",
            !scan.engine_available
              ? "border-border text-muted-foreground"
              : scan.infected.length > 0
                ? "border-red-500/40 text-red-600"
                : "border-emerald-500/40 text-emerald-600",
          )}
        >
          {!scan.engine_available
            ? "Antivirus engine (ClamAV) is not installed on this node."
            : scan.infected.length === 0
              ? `✓ No threats found in ${scan.scanned_path}.`
              : `⚠ ${scan.infected.length} infected file(s) in ${scan.scanned_path}:`}
          {scan.infected.length > 0 && (
            <ul className="mt-1 list-disc pl-5 font-mono text-xs">
              {scan.infected.map((i, idx) => (
                <li key={idx}>
                  {i.file} — {i.signature}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div className="flex items-center gap-1 text-sm text-muted-foreground">
        <button className="hover:text-foreground" onClick={() => setPath("/")}>
          root
        </button>
        {segments.map((seg, i) => (
          <span key={i} className="flex items-center gap-1">
            <span>/</span>
            <button
              className="hover:text-foreground"
              onClick={() => setPath("/" + segments.slice(0, i + 1).join("/"))}
            >
              {seg}
            </button>
          </span>
        ))}
      </div>

      <Card>
        <CardContent className="p-0">
          <table className="w-full text-sm">
            <thead className="border-b border-border text-left text-muted-foreground">
              <tr>
                <th className="px-6 py-3 font-medium">Name</th>
                <th className="px-6 py-3 font-medium">Size</th>
                <th className="px-6 py-3 font-medium">Modified</th>
                <th className="px-6 py-3" />
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <tr
                  key={e.name}
                  className="group border-b border-border/60 last:border-0 hover:bg-muted/60"
                >
                  <td className="px-6 py-3">
                    <button
                      className="flex items-center gap-2 hover:text-foreground"
                      onClick={() => openEntry(e)}
                    >
                      {e.type === "dir" ? (
                        <Folder className="h-4 w-4 text-primary" />
                      ) : (
                        <File className="h-4 w-4 text-muted-foreground" />
                      )}
                      {e.name}
                    </button>
                  </td>
                  <td className="px-6 py-3 text-muted-foreground">{fmt(e.size)}</td>
                  <td className="px-6 py-3 text-muted-foreground">
                    {e.modified ? new Date(e.modified).toLocaleString() : "—"}
                  </td>
                  <td className="px-6 py-3 text-right">
                    <button
                      className="text-muted-foreground opacity-0 transition group-hover:opacity-100 hover:text-red-600"
                      onClick={() => remove(e)}
                      aria-label={`Delete ${e.name}`}
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </td>
                </tr>
              ))}
              {entries.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-6 py-8 text-center text-muted-foreground">
                    {siteId ? "Empty directory." : "Select a site to browse its files."}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </CardContent>
      </Card>

      {viewer && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          onClick={() => setViewer(null)}
        >
          <div
            className="flex max-h-[85vh] w-full max-w-3xl flex-col overflow-hidden rounded-lg border border-border bg-background shadow-xl"
            onClick={(ev) => ev.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-border px-4 py-3">
              <span className="truncate font-mono text-sm">{viewer.path}</span>
              <div className="flex items-center gap-2">
                {viewer.encoding === "utf8" && (
                  <Button size="sm" disabled={busy} onClick={saveFile}>
                    <Save className="h-4 w-4" />
                    Save
                  </Button>
                )}
                <Button variant="ghost" size="icon" onClick={() => setViewer(null)}>
                  <X className="h-4 w-4" />
                </Button>
              </div>
            </div>
            <div className="overflow-auto p-4">
              {viewer.truncated ? (
                <p className="text-sm text-muted-foreground">
                  File is too large to edit inline ({fmt(viewer.size)}).
                </p>
              ) : viewer.encoding === "utf8" ? (
                <textarea
                  value={draft}
                  onChange={(ev) => setDraft(ev.target.value)}
                  spellCheck={false}
                  className="h-[60vh] w-full resize-none rounded-md border border-input bg-background p-3 font-mono text-xs outline-none"
                />
              ) : (
                <p className="text-sm text-muted-foreground">
                  Binary file ({fmt(viewer.size)}) — preview and inline editing are not available.
                </p>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
