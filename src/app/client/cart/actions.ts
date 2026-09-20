"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import type { ActionState } from "@/components/action-form";
import { requireAccount } from "@/lib/account";
import { CartError, checkoutCart, removeFromCart } from "@/lib/cart";
import { rateLimit } from "@/lib/rate-limit";
import { requestMeta } from "@/lib/request";

export async function removeItem(form: FormData) {
  const { account } = await requireAccount("manage");
  await removeFromCart(account.id, z.string().uuid().parse(form.get("id")));
  revalidatePath("/client", "layout");
}

export async function checkout(_: ActionState, form: FormData): Promise<ActionState> {
  const { account } = await requireAccount("manage");
  if (!rateLimit(`cart-checkout:${account.id}`, 20, 60 * 60_000)) return { error: "Too many attempts. Try again in a few minutes." };
  let invoiceId: string;
  try {
    ({ invoiceId } = await checkoutCart({ companyId: account.id, clientId: account.ownerUserId, coupon: String(form.get("coupon") ?? "").slice(0, 40), contact: Object.fromEntries(form), ip: (await requestMeta()).ip }));
  } catch (err) {
    if (err instanceof CartError) return { error: err.message };
    throw err;
  }
  revalidatePath("/client", "layout");
  redirect(`/client/invoices/${invoiceId}`);
}
