"use client";

import type { ReactNode } from "react";
import { Receipt } from "lucide-react";

export default function PortalLayout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="flex items-center justify-between border-b border-border px-6 py-3">
        <div className="flex items-center gap-2">
          <Receipt className="h-5 w-5 text-primary" />
          <span className="font-medium">Aster Billing</span>
          <span className="text-sm text-muted-foreground">· Area cliente</span>
        </div>
        <span className="text-sm text-muted-foreground">Globex SpA</span>
      </header>
      <main className="mx-auto max-w-3xl space-y-5 p-6">{children}</main>
    </div>
  );
}
