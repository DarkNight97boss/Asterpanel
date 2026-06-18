"use client";

import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";

import { navItemFor, tileColors, type TileColor } from "@/lib/nav";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";

// PageHeader renders a localized page title + optional description, led by the
// page's category icon in a coloured chip — the cPanel/Plesk look, consistent
// with the dashboard launcher. The icon and accent colour are resolved from the
// nav config by the current path, so a page gets them for free; pass `icon` /
// `color` to override. `description` may be a plain string (translated through
// the i18n dictionary) or arbitrary JSX.
export function PageHeader({
  title,
  description,
  icon,
  color,
}: {
  title: string;
  description?: ReactNode;
  icon?: LucideIcon;
  color?: TileColor;
}) {
  const { t } = useT();
  const pathname = usePathname();
  const resolved = navItemFor(pathname);

  const Icon = icon ?? resolved?.item.icon;
  const chip = tileColors[color ?? resolved?.color ?? "indigo"].chip;

  return (
    <div className="flex items-center gap-4">
      {Icon && (
        <span className={cn("flex h-11 w-11 shrink-0 items-center justify-center rounded-xl", chip)}>
          <Icon className="h-5 w-5" />
        </span>
      )}
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold tracking-tight">{t(title)}</h1>
        {description != null && (
          <p className="text-sm text-muted-foreground">
            {typeof description === "string" ? t(description) : description}
          </p>
        )}
      </div>
    </div>
  );
}
