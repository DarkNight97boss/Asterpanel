"use client";

import { useEffect, useRef } from "react";
import { fetchLogs } from "@/app/client/platform-actions";

/** Re-requests the logs every few seconds while the page stays open. Stops with the tab: nothing runs unattended. */
export function LiveLogs({ workloadId }: { workloadId: string }) {
  const form = useRef<HTMLFormElement>(null);
  useEffect(() => {
    const timer = setTimeout(() => form.current?.requestSubmit(), 5000);
    return () => clearTimeout(timer);
  }, []);
  return (
    <form ref={form} action={fetchLogs} hidden>
      <input type="hidden" name="id" value={workloadId} />
      <input type="hidden" name="live" value="1" />
    </form>
  );
}
