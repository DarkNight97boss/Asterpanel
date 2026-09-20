"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import type { ActionState } from "@/components/action-form";
import { requireAccount } from "@/lib/account";
import { BlueprintError, parseSlugs } from "@/platform/blueprints";
import { deleteBlueprint, PlatformError, saveBlueprint } from "@/platform/engine";

const PATH = "/client/company/blueprints";

export async function saveBlueprintAction(_: ActionState, form: FormData): Promise<ActionState> {
  const { user, account } = await requireAccount("manage");
  const text = (name: string) => String(form.get(name) ?? "").slice(0, 4000);
  try {
    const id = text("blueprintId");
    await saveBlueprint(account.id, { id: id ? z.string().uuid().parse(id) : undefined, name: text("name"), spec: { plugins: parseSlugs(text("plugins")), theme: parseSlugs(text("theme"))[0], permalinks: text("permalinks"), timezone: text("timezone"), hideFromSearch: form.has("hideFromSearch") } }, user.id);
  } catch (err) {
    if (err instanceof PlatformError || err instanceof BlueprintError) return { error: err.message };
    throw err;
  }
  revalidatePath(PATH);
  return { ok: "Saved" };
}

export async function removeBlueprint(_: ActionState, form: FormData): Promise<ActionState> {
  const { user, account } = await requireAccount("manage");
  await deleteBlueprint(account.id, z.string().uuid().parse(form.get("blueprintId")), user.id);
  revalidatePath(PATH);
  return { ok: "Removed" };
}
