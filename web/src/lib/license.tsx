"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { Lock } from "lucide-react";

import { apiGet } from "@/lib/api";

export interface LicenseInfo {
  edition: string;
  features: string[];
  max_nodes: number;
  issued_to: string;
  expires_at: string | null;
}

// Premium feature keys (must match control-plane/internal/licensing).
export const Feature = {
  Reseller: "reseller",
  WhiteLabel: "white_label",
  Billing: "billing",
  Migration: "migration",
  MultiNode: "multi_node",
} as const;

const DEFAULT: LicenseInfo = {
  edition: "community",
  features: [],
  max_nodes: 1,
  issued_to: "",
  expires_at: null,
};

interface LicenseState {
  license: LicenseInfo;
  hasFeature: (f: string) => boolean;
  isCommunity: boolean;
}

const Ctx = createContext<LicenseState | null>(null);

export function LicenseProvider({ children }: { children: ReactNode }) {
  const [license, setLicense] = useState<LicenseInfo>(DEFAULT);

  useEffect(() => {
    apiGet<{ license: LicenseInfo }>("/api/v1/license")
      .then((r) => setLicense(r.license ?? DEFAULT))
      .catch(() => {
        /* fall back to Community */
      });
  }, []);

  const value: LicenseState = {
    license,
    hasFeature: (f) => license.features?.includes(f) ?? false,
    isCommunity: license.edition === "community",
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useLicense(): LicenseState {
  return useContext(Ctx) ?? { license: DEFAULT, hasFeature: () => false, isCommunity: true };
}

// ProGate renders its children only when the license includes `feature`;
// otherwise it shows an upgrade prompt. Used to lock whole Pro pages/sections.
export function ProGate({ feature, children }: { feature: string; children: ReactNode }) {
  const { hasFeature } = useLicense();
  if (hasFeature(feature)) return <>{children}</>;
  return (
    <div className="mx-auto max-w-md rounded-lg border border-amber-500/30 bg-amber-500/5 p-8 text-center">
      <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-amber-500/15">
        <Lock className="h-6 w-6 text-amber-400" />
      </div>
      <h2 className="text-lg font-semibold">This is a Pro feature</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        It is part of AsterPanel&apos;s commercial layer. Upgrade to a Pro license to unlock it.
      </p>
      <p className="mt-3 inline-block rounded bg-muted px-2 py-1 font-mono text-xs text-muted-foreground">
        {feature}
      </p>
    </div>
  );
}
