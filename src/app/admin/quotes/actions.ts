"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import type { ActionState } from "@/components/action-form";
import { requireArea } from "@/lib/auth";
import { BillingError } from "@/lib/billing";
import { closeQuote, createQuote } from "@/lib/quotes";

export async function newQuote(_: ActionState, form: FormData): Promise<ActionState> {
  const staff = await requireArea("billing");
  const f = Object.fromEntries(form);
  try {
    await createQuote({ companyId: z.string().uuid().parse(f.companyId), title: String(f.title ?? ""), lines: String(f.lines ?? "").slice(0, 20_000), notes: String(f.notes ?? ""), validDays: Number(f.validDays), actorId: staff.id });
  } catch (err) {
    if (err instanceof BillingError) return { error: err.message };
    if (err instanceof z.ZodError) return { error: "Choose a customer" };
    throw err;
  }
  revalidatePath("/admin/quotes");
  return { ok: "Sent. The customer finds it under Company settings → Quotes." };
}

export async function withdrawQuote(form: FormData) {
  const staff = await requireArea("billing");
  await closeQuote(z.string().uuid().parse(form.get("id")), "withdrawn", null, staff.id);
  revalidatePath("/admin/quotes");
}
