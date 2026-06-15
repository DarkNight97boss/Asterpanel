"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

import { apiGet } from "@/lib/api";

export interface Branding {
  panel_name: string;
  logo_url: string;
  primary_color: string;
  support_email: string;
  support_url: string;
}

const DEFAULT: Branding = {
  panel_name: "AsterPanel",
  logo_url: "",
  primary_color: "#6366f1",
  support_email: "",
  support_url: "",
};

interface BrandingState {
  branding: Branding;
  refresh: () => Promise<void>;
  setBranding: (b: Branding) => void;
}

const Ctx = createContext<BrandingState | null>(null);

export function BrandingProvider({ children }: { children: ReactNode }) {
  const [branding, setBranding] = useState<Branding>(DEFAULT);

  async function refresh() {
    try {
      const res = await apiGet<{ branding: Branding }>("/api/v1/branding");
      setBranding(res.branding);
    } catch {
      // keep defaults — branding is best-effort cosmetic state
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  // Apply the brand live: theme color + document title.
  useEffect(() => {
    if (branding.primary_color) {
      document.documentElement.style.setProperty("--color-primary", branding.primary_color);
    }
    if (branding.panel_name) {
      document.title = branding.panel_name;
    }
  }, [branding]);

  return <Ctx.Provider value={{ branding, refresh, setBranding }}>{children}</Ctx.Provider>;
}

export function useBranding(): BrandingState {
  return useContext(Ctx) ?? { branding: DEFAULT, refresh: async () => {}, setBranding: () => {} };
}
