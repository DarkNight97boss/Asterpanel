"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Activity, Globe, Server, type LucideIcon } from "lucide-react";

import { groups, tileColors } from "@/lib/nav";
import { useAuth } from "@/lib/auth";
import { useBranding } from "@/lib/branding";
import { useLicense } from "@/lib/license";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { listNodes, listWebsites, type ServerNode, type Website } from "@/lib/api";

export default function DashboardPage() {
  const [nodes, setNodes] = useState<ServerNode[]>([]);
  const [sites, setSites] = useState<Website[]>([]);
  const [error, setError] = useState<string | null>(null);

  const { user } = useAuth();
  const { branding } = useBranding();
  const { hasFeature } = useLicense();
  const { t } = useT();

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

  // Everything except the standalone "Overview" entry becomes a launcher section.
  const sections = groups.filter((g) => g.label);

  return (
    <div className="space-y-8">
      {/* Hero */}
      <section className="relative overflow-hidden rounded-2xl bg-gradient-to-br from-indigo-600 via-violet-600 to-fuchsia-500 px-6 py-7 text-white shadow-lg sm:px-8">
        <div className="pointer-events-none absolute -right-12 -top-16 h-52 w-52 rounded-full bg-white/10 blur-2xl" />
        <div className="pointer-events-none absolute -bottom-24 right-32 h-44 w-44 rounded-full bg-fuchsia-300/20 blur-2xl" />
        <div className="relative z-10 flex flex-wrap items-center justify-between gap-6">
          <div>
            <p className="text-sm font-medium text-white/70">{t("Welcome back")}</p>
            <h1 className="mt-1 text-2xl font-semibold tracking-tight">{branding.panel_name}</h1>
            {user?.email && <p className="mt-1 text-sm text-white/80">{user.email}</p>}
          </div>
          <div className="flex flex-wrap gap-3">
            <HeroStat icon={Server} value={nodes.length} caption={t("Nodes")} sub={`${onlineNodes} ${t("online")}`} />
            <HeroStat icon={Globe} value={sites.length} caption={t("Websites")} sub={`${activeSites} ${t("active")}`} />
            <HeroStat icon={Activity} value={nodes.length ? t("OK") : "—"} caption={t("Health")} sub={t("last 5 min")} />
          </div>
        </div>
      </section>

      {error && <p className="text-sm text-red-600">{error}</p>}

      {/* Feature launcher */}
      {sections.map((group) => {
        const color = tileColors[group.color];
        return (
          <section key={group.label} className="space-y-3">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              {t(group.label!)}
            </h2>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {group.items.map((item) => {
                const Icon = item.icon;
                const locked = item.feature ? !hasFeature(item.feature) : false;
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    className="group relative flex items-start gap-4 rounded-2xl border border-border bg-card p-4 transition-all duration-200 hover:-translate-y-0.5 hover:border-primary/30 hover:shadow-lg"
                  >
                    <span
                      className={cn(
                        "flex h-11 w-11 shrink-0 items-center justify-center rounded-xl transition-colors group-hover:text-white",
                        color.chip,
                        color.hover,
                      )}
                    >
                      <Icon className="h-5 w-5" />
                    </span>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="truncate text-sm font-medium">{t(item.label)}</p>
                        {locked && (
                          <span
                            className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-amber-600"
                            title="Pro feature — requires a license"
                          >
                            Pro
                          </span>
                        )}
                      </div>
                      {item.desc && (
                        <p className="mt-0.5 text-xs leading-snug text-muted-foreground">{t(item.desc)}</p>
                      )}
                    </div>
                  </Link>
                );
              })}
            </div>
          </section>
        );
      })}
    </div>
  );
}

function HeroStat({
  icon: Icon,
  value,
  caption,
  sub,
}: {
  icon: LucideIcon;
  value: number | string;
  caption: string;
  sub: string;
}) {
  return (
    <div className="flex items-center gap-3 rounded-xl bg-white/10 px-4 py-2.5 ring-1 ring-inset ring-white/15 backdrop-blur-sm">
      <Icon className="h-5 w-5 text-white/80" />
      <div className="leading-tight">
        <div className="flex items-baseline gap-1.5">
          <span className="text-lg font-semibold">{value}</span>
          <span className="text-[11px] font-medium text-white/70">{caption}</span>
        </div>
        <p className="text-[11px] text-white/70">{sub}</p>
      </div>
    </div>
  );
}
