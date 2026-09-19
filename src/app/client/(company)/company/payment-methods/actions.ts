"use server";

import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/db";
import { requireAccount } from "@/lib/account";
import { audit } from "@/lib/audit";
import { removePaymentMethod, setDefaultPaymentMethod } from "@/lib/payment-methods";

const PATH = "/client/company/payment-methods";

export async function makeDefault(form: FormData) {
  const { user, account } = await requireAccount("billing");
  await setDefaultPaymentMethod(account.id, z.string().uuid().parse(form.get("id")));
  await audit(user.id, "paymentmethod.default", "company", account.id);
  revalidatePath(PATH);
}

export async function removeCard(form: FormData) {
  const { user, account } = await requireAccount("billing");
  await removePaymentMethod(account.id, z.string().uuid().parse(form.get("id")));
  await audit(user.id, "paymentmethod.removed", "company", account.id);
  revalidatePath(PATH);
}

export async function setAutoPay(form: FormData) {
  const { user, account } = await requireAccount("billing");
  const autoPay = form.get("autoPay") === "1";
  await (await getDb()).update(schema.companies).set({ autoPay }).where(eq(schema.companies.id, account.id));
  await audit(user.id, autoPay ? "autopay.on" : "autopay.off", "company", account.id);
  revalidatePath(PATH);
}
