import * as React from "react";

import { cn } from "@/lib/utils";

const tones: Record<string, string> = {
  active: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30",
  online: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30",
  provisioning: "bg-amber-500/15 text-amber-400 border-amber-500/30",
  pending: "bg-amber-500/15 text-amber-400 border-amber-500/30",
  error: "bg-red-500/15 text-red-400 border-red-500/30",
  offline: "bg-zinc-500/15 text-zinc-400 border-zinc-500/30",
  default: "bg-zinc-500/15 text-zinc-300 border-zinc-500/30",
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
