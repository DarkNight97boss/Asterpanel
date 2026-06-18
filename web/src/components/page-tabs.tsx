"use client";

import type { LucideIcon } from "lucide-react";

import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";

export type PageTab = { id: string; label: string; icon: LucideIcon };

// PageTabs is the in-page sub-navigation for tool pages that bundle several
// functions (DNS, Email, Databases…). It renders a segmented bar of icon + label
// tabs so each function gets its own organized panel instead of one long scroll.
// Controlled: the page owns the active id and swaps the panel it renders.
export function PageTabs({
  tabs,
  active,
  onChange,
  className,
}: {
  tabs: PageTab[];
  active: string;
  onChange: (id: string) => void;
  className?: string;
}) {
  const { t } = useT();
  return (
    <div
      role="tablist"
      aria-orientation="horizontal"
      className={cn(
        "flex flex-wrap gap-1 rounded-xl border border-border bg-card p-1.5 shadow-card",
        className,
      )}
    >
      {tabs.map((tab) => {
        const Icon = tab.icon;
        const on = tab.id === active;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={on}
            onClick={() => onChange(tab.id)}
            className={cn(
              "inline-flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors",
              on
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-muted hover:text-foreground",
            )}
          >
            <Icon className="h-4 w-4 shrink-0" />
            {t(tab.label)}
          </button>
        );
      })}
    </div>
  );
}
