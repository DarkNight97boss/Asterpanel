"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { LogOut, Menu, ShieldCheck, X } from "lucide-react";

import { groups } from "@/lib/nav";
import { useAuth } from "@/lib/auth";
import { useBranding } from "@/lib/branding";
import { useLicense } from "@/lib/license";
import { LanguageSwitcher, useT } from "@/lib/i18n";
import { ThemeToggle } from "@/lib/theme";
import { cn } from "@/lib/utils";

/** Compact top bar shown only on small screens — opens the sidebar drawer. */
export function MobileTopBar({ onOpen }: { onOpen: () => void }) {
  const { branding } = useBranding();
  return (
    <header className="flex items-center gap-3 border-b border-border bg-card px-4 py-3 lg:hidden">
      <button
        type="button"
        onClick={onOpen}
        aria-label="Open menu"
        className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        <Menu className="h-5 w-5" />
      </button>
      {branding.logo_url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={branding.logo_url} alt="" className="h-5 w-5 rounded object-contain" />
      ) : (
        <ShieldCheck className="h-5 w-5 text-primary" />
      )}
      <span className="truncate font-semibold">{branding.panel_name}</span>
    </header>
  );
}

export function Sidebar({ open = false, onClose }: { open?: boolean; onClose?: () => void }) {
  const pathname = usePathname();
  const { user, logout } = useAuth();
  const { branding } = useBranding();
  const { license, hasFeature } = useLicense();
  const { t } = useT();

  return (
    <>
      {/* Backdrop — mobile only, while the drawer is open. */}
      <div
        aria-hidden
        onClick={onClose}
        className={cn(
          "fixed inset-0 z-40 bg-black/50 transition-opacity lg:hidden",
          open ? "opacity-100" : "pointer-events-none opacity-0",
        )}
      />

      <aside
        className={cn(
          "fixed inset-y-0 left-0 z-50 flex w-60 shrink-0 flex-col border-r border-border bg-card transition-transform duration-200 lg:static lg:z-auto lg:translate-x-0",
          open ? "translate-x-0" : "-translate-x-full",
        )}
      >
        <div className="flex items-center gap-2 px-6 py-5">
          {branding.logo_url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={branding.logo_url} alt="" className="h-5 w-5 rounded object-contain" />
          ) : (
            <ShieldCheck className="h-5 w-5 text-primary" />
          )}
          <span className="truncate font-semibold">{branding.panel_name}</span>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close menu"
            className="ml-auto inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground lg:hidden"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <nav className="flex-1 space-y-4 overflow-y-auto px-4 pb-4">
          {groups.map((group, i) => (
            <div key={group.label ?? i} className="space-y-0.5">
              {group.label && (
                <p className="px-3 pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60">
                  {t(group.label)}
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
                    onClick={onClose}
                    className={cn(
                      "flex items-center gap-3 rounded-md px-3 py-1.5 text-sm transition-colors",
                      active
                        ? "bg-primary/15 text-primary"
                        : "text-muted-foreground hover:bg-muted hover:text-foreground",
                    )}
                  >
                    <Icon className="h-4 w-4 shrink-0" />
                    <span className="flex-1">{t(item.label)}</span>
                    {locked && (
                      <span
                        className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-amber-600"
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
          <div className="mt-1 flex items-center gap-2">
            <button
              onClick={() => logout()}
              className="flex flex-1 items-center gap-3 rounded-md px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <LogOut className="h-4 w-4" />
              {t("Sign out")}
            </button>
            <ThemeToggle />
            <LanguageSwitcher />
          </div>
        </div>
      </aside>
    </>
  );
}
