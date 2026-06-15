"use client";

import { useCallback, useEffect, useState } from "react";
import { File, Folder, Upload } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { apiGet } from "@/lib/api";

interface Entry {
  name: string;
  type: "dir" | "file";
  size: number | null;
  modified: string;
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
  return `${n.toFixed(0)} ${u[i]}`;
}

export default function FilesPage() {
  const [path, setPath] = useState("/");
  const [entries, setEntries] = useState<Entry[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (p: string) => {
    try {
      const res = await apiGet<{ path: string; entries: Entry[] }>(
        `/api/v1/files?path=${encodeURIComponent(p)}`,
      );
      setEntries(res.entries);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    }
  }, []);

  useEffect(() => {
    load(path);
  }, [path, load]);

  const segments = path === "/" ? [] : path.slice(1).split("/");

  function open(entry: Entry) {
    if (entry.type !== "dir") return;
    setPath(path === "/" ? `/${entry.name}` : `${path}/${entry.name}`);
  }

  return (
    <div className="space-y-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">File Manager</h1>
          <p className="text-sm text-muted-foreground">Browse and manage files on the node.</p>
        </div>
        <Button variant="outline">
          <Upload className="h-4 w-4" />
          Upload
        </Button>
      </header>

      {error && <p className="text-sm text-red-400">{error}</p>}

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
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <tr
                  key={e.name}
                  onClick={() => open(e)}
                  className={cn(
                    "border-b border-border/60 last:border-0",
                    e.type === "dir" && "cursor-pointer hover:bg-muted/60",
                  )}
                >
                  <td className="px-6 py-3">
                    <span className="flex items-center gap-2">
                      {e.type === "dir" ? (
                        <Folder className="h-4 w-4 text-primary" />
                      ) : (
                        <File className="h-4 w-4 text-muted-foreground" />
                      )}
                      {e.name}
                    </span>
                  </td>
                  <td className="px-6 py-3 text-muted-foreground">{fmt(e.size)}</td>
                  <td className="px-6 py-3 text-muted-foreground">
                    {new Date(e.modified).toLocaleString()}
                  </td>
                </tr>
              ))}
              {entries.length === 0 && (
                <tr>
                  <td colSpan={3} className="px-6 py-8 text-center text-muted-foreground">
                    Empty directory.
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
