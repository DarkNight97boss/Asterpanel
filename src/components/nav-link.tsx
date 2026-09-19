"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "./ui";

/** Sidebar link: 40px row, beige when active. */
export function NavLink({ href, exact, children }: { href: string; exact?: boolean; children: React.ReactNode }) {
  const pathname = usePathname();
  const active = exact ? pathname === href : pathname === href || pathname.startsWith(`${href}/`);
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex h-10 items-center gap-2 rounded-md px-4 text-sm font-medium whitespace-nowrap transition",
        active ? "bg-border text-fg" : "text-body hover:bg-border/60 hover:text-fg",
      )}
    >
      {children}
    </Link>
  );
}
