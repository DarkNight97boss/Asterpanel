"use server";

import { revalidatePath } from "next/cache";
import { and, eq } from "drizzle-orm";
import type { ActionState } from "@/components/action-form";
import { getDb, schema } from "@/db";
import { mayAccess, requireAccount } from "@/lib/account";
import { rateLimit } from "@/lib/rate-limit";
import * as engine from "@/platform/engine";

/** Running live WordPress sites of the active company that this member may touch. */
async function sites(permission: "hosting" | "manage") {
  const { user, account } = await requireAccount(permission);
  const rows = await (await getDb()).select().from(schema.workloads).where(and(eq(schema.workloads.companyId, account.id), eq(schema.workloads.type, "wordpress"), eq(schema.workloads.environment, "live"), eq(schema.workloads.status, "running")));
  return { user, account, rows: rows.filter((w) => mayAccess(account, w)) };
}

export async function bulkScan(): Promise<ActionState> {
  const { user, account, rows } = await sites("hosting");
  if (!rateLimit(`bulk-scan:${account.id}`, 6, 60 * 60_000)) return { error: "Too many attempts. Try again in a few minutes." };
  for (const w of rows) await engine.runTool(w.id, "wp.inventory", {}, user.id).catch(() => {});
  revalidatePath("/client/updates");
  return { ok: "Scanning. The list fills in as each site answers." };
}

/** One plugin or theme on the chosen sites, or everything everywhere. Each site refreshes its list afterwards. */
export async function bulkUpdate(_: ActionState, form: FormData): Promise<ActionState> {
  const { user, account, rows } = await sites("manage");
  if (!rateLimit(`bulk-update:${account.id}`, 20, 60 * 60_000)) return { error: "Too many attempts. Try again in a few minutes." };
  const everything = form.get("all") === "1";
  const kind = form.get("kind") === "theme" ? "theme" : "plugin";
  const name = String(form.get("name") ?? "");
  if (!everything && !/^[\w.-]{1,100}$/.test(name)) return { error: "Invalid request" };
  const wanted = new Set(form.getAll("site").map(String));
  const targets = everything ? rows : rows.filter((w) => wanted.has(w.id));
  for (const w of targets) {
    try {
      if (everything) {
        await engine.runTool(w.id, "wp.update", { kind: "plugin", name: "" }, user.id);
        await engine.runTool(w.id, "wp.update", { kind: "theme", name: "" }, user.id);
      } else await engine.runTool(w.id, "wp.update", { kind, name }, user.id);
      await engine.runTool(w.id, "wp.inventory", {}, user.id);
    } catch {
      // A site that stopped meanwhile is skipped; the others go ahead.
    }
  }
  revalidatePath("/client/updates");
  return { ok: `Started on ${targets.length} site(s)` };
}
