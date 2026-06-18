import * as React from "react";

import { cn } from "@/lib/utils";

const tones: Record<string, string> = {
  active: "bg-emerald-500/10 text-emerald-700 border-emerald-500/25",
  online: "bg-emerald-500/10 text-emerald-700 border-emerald-500/25",
  provisioning: "bg-amber-500/10 text-amber-700 border-amber-500/25",
  pending: "bg-amber-500/10 text-amber-700 border-amber-500/25",
  error: "bg-red-500/10 text-red-700 border-red-500/25",
  offline: "bg-zinc-500/10 text-zinc-600 border-zinc-500/25",
  default: "bg-zinc-500/10 text-zinc-600 border-zinc-500/25",
};

export function StatusBadge({ status }: { status: string }) {
  const tone = tones[status] ?? tones.default;
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium capitalize",
        tone,
      )}
    >
      {status}
    </span>
  );
}
