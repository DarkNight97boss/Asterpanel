"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import type { ActionState } from "@/components/action-form";
import { requireAccount } from "@/lib/account";
import { deleteEnvGroup, PlatformError, saveEnvGroup } from "@/platform/engine";

const PATH = "/client/company/variables";

/** `KEY=value` lines. Unlike a silent skip, a bad line is an error: a missing variable breaks apps in confusing ways. */
function parse(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!m) throw new PlatformError(`Not a KEY=value line: “${line.slice(0, 40)}”`);
    out[m[1]] = m[2];
  }
  return out;
}

export async function saveGroup(_: ActionState, form: FormData): Promise<ActionState> {
  const { user, account } = await requireAccount("manage");
  try {
    const id = String(form.get("groupId") ?? "");
    await saveEnvGroup(account.id, { id: id ? z.string().uuid().parse(id) : undefined, name: String(form.get("name") ?? ""), vars: parse(String(form.get("vars") ?? "").slice(0, 100_000)) }, user.id);
  } catch (err) {
    if (err instanceof PlatformError) return { error: err.message };
    throw err;
  }
  revalidatePath(PATH);
  return { ok: "Saved. The services that use this group restart with the new values." };
}

export async function removeGroup(_: ActionState, form: FormData): Promise<ActionState> {
  const { user, account } = await requireAccount("manage");
  try {
    await deleteEnvGroup(account.id, z.string().uuid().parse(form.get("groupId")), user.id);
  } catch (err) {
    if (err instanceof PlatformError) return { error: err.message };
    throw err;
  }
  revalidatePath(PATH);
  return { ok: "Removed" };
}
