"use client";

import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import type { ReactNode } from "react";

import { useAuth } from "@/lib/auth";
import { BrandingProvider } from "@/lib/branding";
import { LicenseProvider } from "@/lib/license";
import { MobileTopBar, Sidebar } from "@/components/sidebar";

export default function DashboardLayout({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
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
            <main className="flex-1 overflow-y-auto px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
              {children}
            </main>
          </div>
        </div>
      </LicenseProvider>
    </BrandingProvider>
  );
}
