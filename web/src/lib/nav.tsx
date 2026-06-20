import {
  Activity,
  Archive,
  BarChart3,
  Bell,
  Boxes,
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
  Layers,
  LayoutDashboard,
  Lock,
  Mail,
  Network,
  Package,
  Palette,
  Receipt,
  ScrollText,
  Server,
  Shield,
  ShieldAlert,
  ShieldCheck,
  Terminal,
  Webhook,
  type LucideIcon,
} from "lucide-react";

import { Feature } from "@/lib/license";

/** A tile colour. Class strings are spelled out in full so Tailwind's JIT
 *  picks them up — never build these by interpolation. */
export type TileColor =
  | "sky"
  | "violet"
  | "rose"
  | "emerald"
  | "amber"
  | "teal"
  | "red"
  | "indigo";

export const tileColors: Record<TileColor, { chip: string; hover: string }> = {
  sky: { chip: "bg-sky-500/10 text-sky-600 dark:text-sky-400", hover: "group-hover:bg-sky-500" },
  violet: { chip: "bg-violet-500/10 text-violet-600 dark:text-violet-400", hover: "group-hover:bg-violet-500" },
  rose: { chip: "bg-rose-500/10 text-rose-600 dark:text-rose-400", hover: "group-hover:bg-rose-500" },
  emerald: { chip: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400", hover: "group-hover:bg-emerald-500" },
  amber: { chip: "bg-amber-500/10 text-amber-600 dark:text-amber-400", hover: "group-hover:bg-amber-500" },
  teal: { chip: "bg-teal-500/10 text-teal-600 dark:text-teal-400", hover: "group-hover:bg-teal-500" },
  red: { chip: "bg-red-500/10 text-red-600 dark:text-red-400", hover: "group-hover:bg-red-500" },
  indigo: { chip: "bg-indigo-500/10 text-indigo-600 dark:text-indigo-400", hover: "group-hover:bg-indigo-500" },
};

export type NavItem = {
  href: string;
  label: string;
  icon: LucideIcon;
  /** Short blurb shown on the dashboard launcher tile. */
  desc?: string;
  feature?: string;
};

export type NavGroup = {
  label: string | null;
  /** Accent colour for this group's launcher tiles. */
  color: TileColor;
  items: NavItem[];
};

export const groups: NavGroup[] = [
  {
    label: null,
    color: "indigo",
    items: [{ href: "/dashboard", label: "Overview", icon: LayoutDashboard, desc: "Fleet status at a glance" }],
  },
  {
    label: "Infrastructure",
    color: "sky",
    items: [
      { href: "/nodes", label: "Nodes", icon: Server, desc: "Server fleet & agents" },
      { href: "/metrics", label: "Metrics", icon: Activity, desc: "CPU, memory, traffic" },
      { href: "/health", label: "Health", icon: HeartPulse, desc: "Uptime & service checks" },
      { href: "/logs", label: "Logs", icon: Terminal, desc: "Live system logs" },
    ],
  },
  {
    label: "Sites",
    color: "violet",
    items: [
      { href: "/sites", label: "Websites", icon: Globe, desc: "Create & manage sites" },
      { href: "/domains", label: "Domains & DNS", icon: Network, desc: "Zones, records, DNSSEC" },
      { href: "/ssl", label: "SSL / TLS", icon: Lock, desc: "Certificates & HTTPS" },
      { href: "/runtime", label: "Runtime", icon: FileCode2, desc: "PHP, Node & app stack" },
      { href: "/analytics", label: "Analytics", icon: BarChart3, desc: "Per-site traffic" },
      { href: "/apps", label: "One-Click Apps", icon: Package, desc: "Install WordPress & more" },
      { href: "/applications", label: "Applications", icon: Boxes, desc: "Deploy apps, env & start command" },
    ],
  },
  {
    label: "Email",
    color: "rose",
    items: [
      { href: "/email", label: "Mailboxes", icon: Mail, desc: "Accounts, aliases & filters" },
      { href: "/webmail", label: "Webmail", icon: Inbox, desc: "Browser mail client" },
    ],
  },
  {
    label: "Data",
    color: "emerald",
    items: [
      { href: "/databases", label: "Databases", icon: Database, desc: "MySQL & PostgreSQL" },
      { href: "/files", label: "File Manager", icon: FolderTree, desc: "Browse & edit files" },
      { href: "/ftp", label: "FTP / SFTP", icon: HardDrive, desc: "Transfer accounts" },
      { href: "/backups", label: "Backups", icon: Archive, desc: "Snapshots & restore" },
    ],
  },
  {
    label: "Automation",
    color: "amber",
    items: [{ href: "/cron", label: "Cron Jobs", icon: Clock, desc: "Scheduled tasks" }],
  },
  {
    label: "Config",
    color: "teal",
    items: [{ href: "/env", label: "Env & Secrets", icon: KeyRound, desc: "Variables & secrets" }],
  },
  {
    label: "Security",
    color: "red",
    items: [
      { href: "/advisor", label: "Security Advisor", icon: ShieldCheck, desc: "Config audit & recommendations" },
      { href: "/firewall", label: "Firewall", icon: Shield, desc: "IP rules & bans" },
      { href: "/waf", label: "WAF", icon: ShieldAlert, desc: "Application firewall" },
      { href: "/audit", label: "Audit Log", icon: ScrollText, desc: "Security events" },
      { href: "/tokens", label: "API Tokens", icon: Key, desc: "Programmatic access" },
    ],
  },
  {
    label: "Account",
    color: "indigo",
    items: [
      { href: "/packages", label: "Packages", icon: Layers, desc: "Hosting plans & quotas" },
      { href: "/reseller", label: "Reseller", icon: Building2, desc: "Sub-accounts & plans", feature: Feature.Reseller },
      { href: "/migrations", label: "Migrations", icon: DownloadCloud, desc: "Import from cPanel", feature: Feature.Migration },
      { href: "/branding", label: "Branding", icon: Palette, desc: "White-label the panel", feature: Feature.WhiteLabel },
      { href: "/webhooks", label: "Webhooks", icon: Webhook, desc: "Event notifications", feature: Feature.WhiteLabel },
      { href: "/billing", label: "Billing", icon: Receipt, desc: "Invoices & usage", feature: Feature.Billing },
      { href: "/notifications", label: "Notifications", icon: Bell, desc: "Alerts & channels" },
    ],
  },
];

/** Resolve the nav entry (and its accent colour) for a pathname, matching the
 *  longest href prefix so nested routes like /email/filters still resolve to
 *  their top-level section. Returns null for unknown paths. */
export function navItemFor(pathname: string): { item: NavItem; color: TileColor } | null {
  let best: { item: NavItem; color: TileColor } | null = null;
  for (const group of groups) {
    for (const item of group.items) {
      if (pathname === item.href || pathname.startsWith(`${item.href}/`)) {
        if (!best || item.href.length > best.item.href.length) {
          best = { item, color: group.color };
        }
      }
    }
  }
  return best;
}
