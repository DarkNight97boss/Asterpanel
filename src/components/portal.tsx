"use client";

import { useSyncExternalStore } from "react";
import { createPortal } from "react-dom";

const subscribe = () => () => {};

/**
 * Renders children into a slot owned by the panel shell (`#shell-crumbs`,
 * `#shell-context-nav`). Lets a nested layout — e.g. one workload — take over
 * the top bar breadcrumb and the sidebar without the shell knowing about it.
 */
export function ShellSlot({ slot, children }: { slot: "crumbs" | "context-nav"; children: React.ReactNode }) {
  // The slot only exists in the browser: null on the server and during hydration.
  const target = useSyncExternalStore(subscribe, () => document.getElementById(`shell-${slot}`), () => null);
  return target ? createPortal(children, target) : null;
}
