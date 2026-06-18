"use client";

import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import type { ReactNode } from "react";
import { Eye } from "lucide-react";

import { useAuth } from "@/lib/auth";
import { BrandingProvider } from "@/lib/branding";
import { LicenseProvider } from "@/lib/license";
import { MobileTopBar, Sidebar } from "@/components/sidebar";

export default function DashboardLayout({ children }: { children: ReactNode }) {
  const { user, loading, impersonating, stopImpersonating } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const [navOpen, setNavOpen] = useState(false);

  useEffect(() => {
    if (!loading && !user) router.replace("/login");
  }, [user, loading, router]);

  // Close the mobile drawer whenever the route changes.
  useEffect(() => {
    setNavOpen(false);
  }, [pathname]);

  if (loading || !user) {
    return (
      <div className="grid min-h-screen place-items-center text-sm text-muted-foreground">
        Loading…
      </div>
    );
  }

  return (
    <BrandingProvider>
      <LicenseProvider>
        <div className="flex h-screen overflow-hidden">
          <Sidebar open={navOpen} onClose={() => setNavOpen(false)} />
          <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
            <MobileTopBar onOpen={() => setNavOpen(true)} />
            {impersonating && (
              <div className="flex items-center gap-3 border-b border-amber-500/30 bg-amber-500/10 px-4 py-2 text-sm text-amber-700 sm:px-6 lg:px-8 dark:text-amber-300">
                <Eye className="h-4 w-4 shrink-0" />
                <span className="min-w-0 flex-1 truncate">
                  Impersonating <span className="font-medium">{impersonating.email}</span> — every
                  action is performed as this user.
                </span>
                <button
                  onClick={() => stopImpersonating()}
                  className="shrink-0 rounded-md border border-amber-500/40 px-2.5 py-1 text-xs font-medium text-amber-800 transition-colors hover:bg-amber-500/20 dark:text-amber-200"
                >
                  Stop impersonating
                </button>
              </div>
            )}
            <main className="flex-1 overflow-y-auto px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
              {children}
            </main>
          </div>
        </div>
      </LicenseProvider>
    </BrandingProvider>
  );
}
