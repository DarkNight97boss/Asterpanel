"use client";

import { useT } from "@/lib/i18n";

// PageHeader renders a localized page title + optional description. Pass the
// English source strings; they're translated through the i18n dictionary, so a
// page adopts localization with a single element and no per-page hook wiring.
export function PageHeader({ title, description }: { title: string; description?: string }) {
  const { t } = useT();
  return (
    <header>
      <h1 className="text-2xl font-semibold">{t(title)}</h1>
      {description && <p className="text-sm text-muted-foreground">{t(description)}</p>}
    </header>
  );
}
