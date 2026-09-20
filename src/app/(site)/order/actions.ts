"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import type { ActionState } from "@/components/action-form";
import { BILLING_CYCLES } from "@/db/schema";
import { requireAccount } from "@/lib/account";
import { requestMeta } from "@/lib/request";
import { BillingError, placeOrder } from "@/lib/billing";
import { DOMAIN_RE } from "@/lib/format";
import { pickedFrom } from "@/lib/product-options";

export async function submitOrder(_: ActionState, form: FormData): Promise<ActionState> {
  const { account: user } = await requireAccount("manage");
  const parsed = z
    .object({
      productId: z.string().uuid(),
      cycle: z.enum(BILLING_CYCLES),
      domain: z.string().trim().toLowerCase().max(253).default(""),
      coupon: z.string().trim().max(40).default(""),
    })
    .safeParse(Object.fromEntries(form));
  if (!parsed.success) return { error: "Invalid order" };
  if (parsed.data.domain && !DOMAIN_RE.test(parsed.data.domain)) return { error: "Enter a valid domain, e.g. example.com" };

  let invoiceId: string;
  try {
    ({ invoiceId } = await placeOrder({ clientId: user.ownerUserId, companyId: user.id, ...parsed.data, options: pickedFrom(form), ip: (await requestMeta()).ip }));
  } catch (err) {
    if (err instanceof BillingError) return { error: err.message };
    throw err;
  }
  redirect(`/client/invoices/${invoiceId}`);
}
