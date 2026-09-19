"use server";

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { ActionState } from "@/components/action-form";
import { getDb, schema } from "@/db";
import { ACCOUNT_COOKIE, requireAccount } from "@/lib/account";
import { audit } from "@/lib/audit";
import { requireUser } from "@/lib/auth";
import { rateLimit } from "@/lib/rate-limit";
import { createCompany } from "@/lib/roles";

const text = (max: number) => z.string().trim().max(max);
const details = z.object({
  orgType: z.enum(["individual", "company"]),
  name: text(120).min(1),
  taxCode: text(40),
  billingName: text(120),
  country: text(80),
  state: text(80),
  city: text(80),
  zip: text(20),
  address1: text(160),
  address2: text(160),
  vatId: text(40),
  sdiCode: z.union([z.string().trim().toUpperCase().regex(/^[A-Z0-9]{7}$/), z.literal("")]),
  pec: z.union([z.string().trim().toLowerCase().email().max(200), z.literal("")]),
});

export async function saveCompanyDetails(_: ActionState, form: FormData): Promise<ActionState> {
  const { user, account } = await requireAccount("billing");
  const parsed = details.safeParse(Object.fromEntries(form));
  if (!parsed.success) return { error: "Check the highlighted fields" };
  const db = await getDb();
  await db.update(schema.companies).set(parsed.data).where(eq(schema.companies.id, account.id));
  await audit(user.id, "company.details_changed", "company", account.id);
  revalidatePath("/client", "layout");
  return { ok: "Saved" };
}

export async function newCompany(_: ActionState, form: FormData): Promise<ActionState> {
  const user = await requireUser();
  const parsed = details.pick({ name: true, orgType: true }).safeParse(Object.fromEntries(form));
  if (!parsed.success) return { error: "Enter a company name" };
  if (!rateLimit(`company:${user.id}`, 5, 60 * 60_000)) return { error: "Too many attempts. Try again in a few minutes." };
  const id = await createCompany(user, parsed.data.name, { orgType: parsed.data.orgType });
  await audit(user.id, "company.created", "company", id, { name: parsed.data.name });
  (await cookies()).set(ACCOUNT_COOKIE, id, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/", maxAge: 60 * 60 * 24 * 365 });
  redirect("/client/company/details");
}
