"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import type { ActionState } from "@/components/action-form";
import { requireArea } from "@/lib/auth";
import { BlueprintError, parseSlugs } from "@/platform/blueprints";
import { deleteBlueprint, PlatformError, saveBlueprint } from "@/platform/engine";

const PATH = "/admin/blueprints";

/** Blueprints without a company: every customer sees them when creating a WordPress site. */
export async function saveShared(_: ActionState, form: FormData): Promise<ActionState> {
  const staff = await requireArea("platform");
  const text = (name: string) => String(form.get(name) ?? "").slice(0, 4000);
  try {
    const id = text("blueprintId");
    await saveBlueprint(null, { id: id ? z.string().uuid().parse(id) : undefined, name: text("name"), spec: { plugins: parseSlugs(text("plugins")), theme: parseSlugs(text("theme"))[0], permalinks: text("permalinks"), timezone: text("timezone"), hideFromSearch: form.has("hideFromSearch") } }, staff.id);
  } catch (err) {
    if (err instanceof PlatformError || err instanceof BlueprintError) return { error: err.message };
    throw err;
  }
  revalidatePath(PATH);
  return { ok: "Saved" };
}

export async function removeShared(_: ActionState, form: FormData): Promise<ActionState> {
  const staff = await requireArea("platform");
  await deleteBlueprint(null, z.string().uuid().parse(form.get("blueprintId")), staff.id);
  revalidatePath(PATH);
  return { ok: "Removed" };
}
