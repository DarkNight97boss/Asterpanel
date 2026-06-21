"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import {
  Bot,
  Box,
  FileText,
  LayoutDashboard,
  LifeBuoy,
  Plug,
  Receipt,
  Server,
  Settings,
  ShoppingCart,
  Users,
} from "lucide-react";

import { cn } from "@/lib/utils";

const NAV = [
  { href: "/admin", label: "Dashboard", icon: LayoutDashboard },
  { href: "/admin/clients", label: "Clienti", icon: Users },
  { href: "/admin/products", label: "Prodotti", icon: Box },
  { href: "/admin/services", label: "Servizi", icon: Server },
  { href: "/admin/invoices", label: "Fatture", icon: FileText },
];

const SOON = [
  { label: "Ordini", icon: ShoppingCart },
  { label: "Supporto", icon: LifeBuoy },
  { label: "Automazione", icon: Bot },
  { label: "Hosting", icon: Plug },
];

export default function AdminLayout({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  return (
    <div className="flex min-h-screen bg-background text-foreground">
      <aside className="flex w-56 shrink-0 flex-col gap-0.5 border-r border-border bg-muted/30 p-3">
        <div className="flex items-center gap-2 px-2 pb-3 pt-2">
          <Receipt className="h-5 w-5 text-primary" />
          <span className="font-medium">Aster Billing</span>
        </div>
        {NAV.map((n) => {
          const active = pathname === n.href;
          const Icon = n.icon;
          return (
            <Link
              key={n.href}
              href={n.href}
              className={cn(
                "flex items-center gap-3 rounded-md px-3 py-2 text-sm",
                active
                  ? "bg-background font-medium text-foreground"
                  : "text-muted-foreground hover:bg-muted",
              )}
            >
              <Icon className="h-4 w-4" />
              {n.label}
            </Link>
          );
        })}
        <div className="px-3 pb-1 pt-3 text-[11px] uppercase tracking-wide text-muted-foreground/60">
          Presto
        </div>
        {SOON.map((s) => {
          const Icon = s.icon;
          return (
            <div
              key={s.label}
              className="flex items-center gap-3 rounded-md px-3 py-2 text-sm text-muted-foreground/45"
            >
              <Icon className="h-4 w-4" />
              {s.label}
            </div>
          );
        })}
        <div className="mt-auto flex items-center gap-3 border-t border-border px-3 pt-3 text-sm text-muted-foreground">
          <Settings className="h-4 w-4" />
          Impostazioni
        </div>
      </aside>
      <main className="flex-1 overflow-x-hidden p-6">{children}</main>
    </div>
  );
}
