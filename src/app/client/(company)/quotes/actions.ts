"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import type { ActionState } from "@/components/action-form";
import { requireAccount } from "@/lib/account";
import { BillingError } from "@/lib/billing";
import { acceptQuote, closeQuote } from "@/lib/quotes";

export async function accept(_: ActionState, form: FormData): Promise<ActionState> {
  const { user, account } = await requireAccount("billing");
  let invoiceId: string;
  try {
    invoiceId = await acceptQuote(z.string().uuid().parse(form.get("id")), account.id, user.id);
  } catch (err) {
    if (err instanceof BillingError) return { error: err.message };
    throw err;
  }
  redirect(`/client/invoices/${invoiceId}`);
}

export async function decline(form: FormData) {
  const { user, account } = await requireAccount("billing");
  await closeQuote(z.string().uuid().parse(form.get("id")), "declined", account.id, user.id);
  revalidatePath("/client/quotes");
}
