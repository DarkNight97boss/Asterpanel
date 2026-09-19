"use client";

import { useState } from "react";

type Option = { label: string; unitPrice: number; max: number };

/** Interactive part of the price calculator block. Numbers only: nothing here is sent anywhere. */
export function Calculator({ base, currency, options, perMonth, cta }: { base: number; currency: string; options: Option[]; perMonth: string; cta?: { label: string; href: string } }) {
  const [qty, setQty] = useState<number[]>(() => options.map(() => 0));
  const total = base + options.reduce((sum, o, i) => sum + o.unitPrice * qty[i], 0);
  return (
    <div className="mx-auto max-w-2xl rounded-card border border-border bg-surface p-6 sm:p-8">
      <div className="space-y-5">
        {options.map((o, i) => (
          <label key={i} className="block">
            <span className="flex items-baseline justify-between gap-4 text-sm">
              <span className="font-medium">{o.label}</span>
              <span className="text-muted">{qty[i]} × {currency}{o.unitPrice.toFixed(2)}</span>
            </span>
            <input type="range" min={0} max={o.max} value={qty[i]} onChange={(e) => setQty((q) => q.map((v, n) => (n === i ? Number(e.target.value) : v)))} className="mt-2 w-full accent-(--accent)" />
          </label>
        ))}
      </div>
      <div className="mt-8 flex flex-wrap items-end justify-between gap-4 border-t border-border pt-6">
        <p className="text-4xl tracking-tight">{currency}{total.toFixed(2)} <span className="text-base text-muted">{perMonth}</span></p>
        {cta && <a href={cta.href} className="rounded-theme bg-primary px-5 py-3 text-sm font-medium text-white hover:opacity-90">{cta.label}</a>}
      </div>
    </div>
  );
}
