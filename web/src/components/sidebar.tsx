"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Activity,
  Archive,
  Bell,
  Building2,
  Clock,
  Database,
  DownloadCloud,
  FileCode2,
  FolderTree,
  Globe,
  HardDrive,
  HeartPulse,
  Inbox,
  Key,
  KeyRound,
  LayoutDashboard,
  Lock,
  LogOut,
  Mail,
  Network,
  Package,
  Palette,
  Receipt,
  ScrollText,
  Server,
  Shield,
  ShieldAlert,
  Terminal,
  ShieldCheck,
  type LucideIcon,
} from "lucide-react";

import { useAuth } from "@/lib/auth";
import { useBranding } from "@/lib/branding";
import { Feature, useLicense } from "@/lib/license";
import { cn } from "@/lib/utils";

type Item = { href: string; label: string; icon: LucideIcon; feature?: string };
type Group = { label: string | null; items: Item[] };

const groups: Group[] = [
  { label: null, items: [{ href: "/dashboard", label: "Overview", icon: LayoutDashboard }] },
  {
    label: "Infrastructure",
    items: [
      { href: "/nodes", label: "Nodes", icon: Server },
      { href: "/metrics", label: "Metrics", icon: Activity },
      { href: "/health", label: "Health", icon: HeartPulse },
      { href: "/logs", label: "Logs", icon: Terminal },
    ],
  },
  {
    label: "Sites",
    items: [
      { href: "/sites", label: "Websites", icon: Globe },
      { href: "/domains", label: "Domains & DNS", icon: Network },
      { href: "/ssl", label: "SSL / TLS", icon: Lock },
      { href: "/runtime", label: "Runtime", icon: FileCode2 },
      { href: "/apps", label: "One-Click Apps", icon: Package },
    ],
  },
  {
    label: "Email",
    items: [
      { href: "/email", label: "Mailboxes", icon: Mail },
      { href: "/webmail", label: "Webmail", icon: Inbox },
    ],
  },
  {
    label: "Data",
    items: [
      { href: "/databases", label: "Databases", icon: Database },
      { href: "/files", label: "File Manager", icon: FolderTree },
      { href: "/ftp", label: "FTP / SFTP", icon: HardDrive },
      { href: "/backups", label: "Backups", icon: Archive },
    ],
  },
  { label: "Automation", items: [{ href: "/cron", label: "Cron Jobs", icon: Clock }] },
  { label: "Config", items: [{ href: "/env", label: "Env & Secrets", icon: KeyRound }] },
  {
    label: "Security",
    items: [
      { href: "/firewall", label: "Firewall", icon: Shield },
      { href: "/waf", label: "WAF", icon: ShieldAlert },
      { href: "/audit", label: "Audit Log", icon: ScrollText },
      { href: "/tokens", label: "API Tokens", icon: Key },
    ],
  },
  {
    label: "Account",
    items: [
      { href: "/reseller", label: "Reseller", icon: Building2, feature: Feature.Reseller },
      { href: "/migrations", label: "Migrations", icon: DownloadCloud, feature: Feature.Migration },
      { href: "/branding", label: "Branding", icon: Palette, feature: Feature.WhiteLabel },
      { href: "/billing", label: "Billing", icon: Receipt, feature: Feature.Billing },
      { href: "/notifications", label: "Notifications", icon: Bell },
    ],
  },
];

export function Sidebar() {
  const pathname = usePathname();
  const { user, logout } = useAuth();
  const { branding } = useBranding();
  const { license, hasFeature } = useLicense();

  return (
    <aside className="flex h-screen w-60 shrink-0 flex-col border-r border-border bg-card/40">
      <div className="flex items-center gap-2 px-6 py-5">
        {branding.logo_url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={branding.logo_url} alt="" className="h-5 w-5 rounded object-contain" />
        ) : (
          <ShieldCheck className="h-5 w-5 text-primary" />
        )}
        <span className="truncate font-semibold">{branding.panel_name}</span>
      </div>

      <nav className="flex-1 space-y-4 overflow-y-auto px-4 pb-4">
        {groups.map((group, i) => (
          <div key={group.label ?? i} className="space-y-0.5">
            {group.label && (
              <p className="px-3 pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60">
                {group.label}
              </p>
            )}
            {group.items.map((item) => {
              const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
              const Icon = item.icon;
              const locked = item.feature ? !hasFeature(item.feature) : false;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={cn(
                    "flex items-center gap-3 rounded-md px-3 py-1.5 text-sm transition-colors",
                    active
                      ? "bg-primary/15 text-primary"
                      : "text-muted-foreground hover:bg-muted hover:text-foreground",
                  )}
                >
                  <Icon className="h-4 w-4 shrink-0" />
                  <span className="flex-1">{item.label}</span>
                  {locked && (
                    <span
                      className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-amber-400"
                      title="Pro feature — requires a license"
                    >
                      Pro
                    </span>
                  )}
                </Link>
              );
            })}
          </div>
        ))}
      </nav>

      <div className="border-t border-border px-4 py-3">
        <div className="mb-1 flex items-center justify-between px-3">
          <p className="truncate text-xs text-muted-foreground" title={user?.email}>
            {user?.email}
          </p>
          <span
            className={cn(
              "ml-2 shrink-0 rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide",
              license.edition === "community"
                ? "bg-muted text-muted-foreground"
                : "bg-primary/15 text-primary",
            )}
            title={
              license.edition === "community"
                ? "Community edition — single node, no commercial features"
                : `${license.edition} license${license.issued_to ? ` · ${license.issued_to}` : ""}`
            }
          >
            {license.edition}
          </span>
        </div>
        <button
          onClick={() => logout()}
          className="mt-1 flex w-full items-center gap-3 rounded-md px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <LogOut className="h-4 w-4" />
          Sign out
        </button>
      </div>
    </aside>
  );
}
