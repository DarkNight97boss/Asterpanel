"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "./ui";

export function NavLink({ href, exact, children }: { href: string; exact?: boolean; children: React.ReactNode }) {
  const pathname = usePathname();
  const active = exact ? pathname === href : pathname === href || pathname.startsWith(`${href}/`);
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex items-center gap-2.5 rounded-theme px-3 py-2 text-sm whitespace-nowrap transition",
        active ? "bg-primary/10 font-medium text-primary" : "text-muted hover:bg-subtle hover:text-fg",
      )}
    >
      {children}
    </Link>
  );
}
