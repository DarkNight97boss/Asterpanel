"use client";

import { useEffect, useState } from "react";

import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { apiGet } from "@/lib/api";

interface Notification {
  id: string;
  type: string;
  severity: string;
  title: string;
  body: string;
  read: boolean;
  at: string;
}

const dot: Record<string, string> = {
  success: "bg-emerald-400",
  error: "bg-red-400",
  warning: "bg-amber-400",
  info: "bg-sky-400",
};

export default function NotificationsPage() {
  const [items, setItems] = useState<Notification[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiGet<{ notifications: Notification[] }>("/api/v1/notifications")
      .then((r) => setItems(r.notifications))
      .catch((e) => setError(e instanceof Error ? e.message : "Failed to load"));
  }, []);

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">Notifications</h1>
        <p className="text-sm text-muted-foreground">Deploys, backups, security alerts and renewals.</p>
      </header>

      {error && <p className="text-sm text-red-600">{error}</p>}

      <Card>
        <CardContent className="divide-y divide-border/60 p-0">
          {items.map((n) => (
            <div key={n.id} className={cn("flex gap-3 px-6 py-4", !n.read && "bg-muted/30")}>
              <span className={cn("mt-1.5 h-2 w-2 shrink-0 rounded-full", dot[n.severity] ?? dot.info)} />
              <div className="flex-1">
                <div className="flex items-center justify-between">
                  <p className={cn("text-sm", n.read ? "font-medium" : "font-semibold")}>{n.title}</p>
                  <span className="text-xs text-muted-foreground">
                    {new Date(n.at).toLocaleString()}
                  </span>
                </div>
                <p className="text-sm text-muted-foreground">{n.body}</p>
                <span className="mt-1 inline-block rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                  {n.type}
                </span>
              </div>
            </div>
          ))}
          {items.length === 0 && (
            <p className="px-6 py-8 text-center text-sm text-muted-foreground">No notifications.</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
