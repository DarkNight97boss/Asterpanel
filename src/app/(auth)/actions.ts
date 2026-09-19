"use server";

import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { ActionState } from "@/components/action-form";
import { getDb, schema } from "@/db";
import { audit } from "@/lib/audit";
import { createSession, destroySession, isStaff, safeNext } from "@/lib/auth";
import { requestMeta } from "@/lib/request";
import { hashPassword, safeEqual, verifyPassword } from "@/lib/crypto";
import { seedStarterContent } from "@/lib/install";
import { notify } from "@/lib/notify";
import { requestPasswordReset, resetPassword } from "@/lib/password-reset";
import { rateLimit } from "@/lib/rate-limit";
import { getSettings, updateSettings } from "@/lib/settings";
import { baseUrl } from "@/lib/url";

const email = z.string().trim().toLowerCase().email().max(254);
const password = z.string().min(10, "Password must be at least 10 characters").max(200);

// Equalises timing between "unknown email" and "wrong password".
const DUMMY_HASH = hashPassword("asterpanel-timing-equaliser");

export async function login(_: ActionState, form: FormData): Promise<ActionState> {
  const { ip } = await requestMeta();
  const parsed = z.object({ email, password: z.string().min(1).max(200) }).safeParse(Object.fromEntries(form));
  if (!parsed.success) return { error: "Invalid email or password" };
  if (!rateLimit(`login:${ip}`, 10, 10 * 60_000) || !rateLimit(`login:${parsed.data.email}`, 5, 10 * 60_000)) {
    return { error: "Too many attempts. Try again in a few minutes." };
  }

  const db = await getDb();
  const user = await db.query.users.findFirst({ where: eq(schema.users.email, parsed.data.email) });
  const valid = await verifyPassword(parsed.data.password, user?.passwordHash ?? (await DUMMY_HASH));
  if (!user || !valid) {
    await audit(user?.id ?? null, "auth.login.failed", "user", user?.id ?? "", { email: parsed.data.email });
    return { error: "Invalid email or password" };
  }
  if (user.status !== "active") return { error: "This account is not active. Contact support." };

  await createSession(user.id);
  await audit(user.id, "auth.login", "user", user.id);
  redirect(safeNext(form.get("next"), isStaff(user) ? "/admin" : "/client"));
}

export async function register(_: ActionState, form: FormData): Promise<ActionState> {
  if (!(await getSettings("general")).allowRegistration) return { error: "Registration is disabled" };
  const { ip } = await requestMeta();
  if (!rateLimit(`register:${ip}`, 5, 60 * 60_000)) return { error: "Too many attempts. Try again in a few minutes." };

  const parsed = z
    .object({
      email,
      password,
      firstName: z.string().trim().min(1, "First name is required").max(100),
      lastName: z.string().trim().min(1, "Last name is required").max(100),
      company: z.string().trim().max(150).default(""),
    })
    .safeParse(Object.fromEntries(form));
  if (!parsed.success) return { error: parsed.error.issues[0].message };

  const db = await getDb();
  const { password: plain, ...profile } = parsed.data;
  const [user] = await db
    .insert(schema.users)
    .values({ ...profile, passwordHash: await hashPassword(plain), role: "client" })
    .onConflictDoNothing({ target: schema.users.email })
    .returning();
  if (!user) return { error: "An account with this email already exists" };

  await createSession(user.id);
  await audit(user.id, "auth.register", "user", user.id);
  notify.welcome(user.id);
  redirect(safeNext(form.get("next"), "/client"));
}

export async function logout() {
  await destroySession();
  redirect("/");
}

export async function install(_: ActionState, form: FormData): Promise<ActionState> {
  if ((await getSettings("general")).installed) redirect("/");

  const token = process.env.INSTALL_TOKEN;
  if (token && !safeEqual(String(form.get("installToken") ?? ""), token)) return { error: "Invalid install token" };

  const parsed = z
    .object({
      siteName: z.string().trim().min(1, "Site name is required").max(80),
      locale: z.enum(["en", "it"]),
      currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/, "Currency must be a 3-letter ISO code"),
      email,
      password,
      firstName: z.string().trim().min(1, "First name is required").max(100),
      lastName: z.string().trim().min(1, "Last name is required").max(100),
    })
    .safeParse(Object.fromEntries(form));
  if (!parsed.success) return { error: parsed.error.issues[0].message };
  const d = parsed.data;

  const db = await getDb();
  const [admin] = await db
    .insert(schema.users)
    .values({
      email: d.email,
      passwordHash: await hashPassword(d.password),
      role: "admin",
      firstName: d.firstName,
      lastName: d.lastName,
    })
    .returning();

  if (form.get("starterContent")) await seedStarterContent(d.siteName);
  await updateSettings("billing", { currency: d.currency });
  await updateSettings("general", {
    installed: true,
    siteName: d.siteName,
    locale: d.locale,
    supportEmail: d.email,
    siteUrl: await baseUrl(),
  });

  await createSession(admin.id);
  await audit(admin.id, "system.installed", "user", admin.id);
  redirect("/admin");
}

export async function forgotPassword(_: ActionState, form: FormData): Promise<ActionState> {
  const { ip } = await requestMeta();
  const parsed = email.safeParse(form.get("email"));
  if (!parsed.success) return { error: "Enter a valid email address" };
  if (!rateLimit(`reset:${ip}`, 5, 60 * 60_000) || !rateLimit(`reset:${parsed.data}`, 3, 60 * 60_000)) {
    return { error: "Too many attempts. Try again in a few minutes." };
  }
  await requestPasswordReset(parsed.data);
  return { ok: "If an account exists for this address, we have sent a link to reset the password." };
}

export async function completePasswordReset(_: ActionState, form: FormData): Promise<ActionState> {
  const { ip } = await requestMeta();
  if (!rateLimit(`reset-complete:${ip}`, 10, 60 * 60_000)) return { error: "Too many attempts. Try again in a few minutes." };
  const parsed = password.safeParse(form.get("password"));
  if (!parsed.success) return { error: parsed.error.issues[0].message };
  if (!(await resetPassword(String(form.get("token") ?? ""), parsed.data))) {
    return { error: "This link is invalid or has expired. Request a new one." };
  }
  redirect("/login?reset=1");
}
