"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/** Re-fetches the current server-rendered page while something is in progress. */
export function AutoRefresh({ active, intervalMs = 2500 }: { active: boolean; intervalMs?: number }) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => document.visibilityState === "visible" && router.refresh(), intervalMs);
    return () => clearInterval(timer);
  }, [active, intervalMs, router]);
  return null;
}
