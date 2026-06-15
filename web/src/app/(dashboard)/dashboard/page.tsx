"use client";

import { useEffect, useState } from "react";
import { Activity, Globe, Server, type LucideIcon } from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { listNodes, listWebsites, type ServerNode, type Website } from "@/lib/api";

export default function DashboardPage() {
  const [nodes, setNodes] = useState<ServerNode[]>([]);
  const [sites, setSites] = useState<Website[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([listNodes(), listWebsites()])
      .then(([n, s]) => {
        setNodes(n);
        setSites(s);
      })
      .catch((e) => setError(e.message));
  }, []);

  const onlineNodes = nodes.filter((n) => n.status === "online").length;
  const activeSites = sites.filter((s) => s.status === "active").length;

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">Overview</h1>
        <p className="text-sm text-muted-foreground">Fleet status at a glance.</p>
      </header>

      {error && <p className="text-sm text-red-400">{error}</p>}

      <div className="grid gap-4 sm:grid-cols-3">
        <Stat icon={Server} label="Server nodes" value={nodes.length} sub={`${onlineNodes} online`} />
        <Stat icon={Globe} label="Websites" value={sites.length} sub={`${activeSites} active`} />
        <Stat icon={Activity} label="Health" value={nodes.length ? "OK" : "—"} sub="last 5 min" />
      </div>
    </div>
  );
}

function Stat({
  icon: Icon,
  label,
  value,
  sub,
}: {
  icon: LucideIcon;
  label: string;
  value: number | string;
  sub: string;
}) {
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">{label}</CardTitle>
        <Icon className="h-4 w-4 text-muted-foreground" />
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-semibold">{value}</div>
        <p className="text-xs text-muted-foreground">{sub}</p>
      </CardContent>
    </Card>
  );
}
