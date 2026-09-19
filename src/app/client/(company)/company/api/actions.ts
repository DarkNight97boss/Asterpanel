"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import type { ActionState } from "@/components/action-form";
import { requireAccount } from "@/lib/account";
import { createApiKey, revokeApiKey } from "@/lib/api-keys";
import { audit } from "@/lib/audit";
import { createWebhook, deleteWebhook, testWebhook, WebhookError } from "@/lib/webhooks";

const PATH = "/client/company/api";

export async function newApiKey(_: ActionState, form: FormData): Promise<ActionState> {
  const { user, account } = await requireAccount("manage");
  const parsed = z.object({ name: z.string().trim().min(1).max(60), scope: z.enum(["read", "write"]), expires: z.enum(["0", "30", "90", "365"]) }).safeParse(Object.fromEntries(form));
  if (!parsed.success) return { error: "Give the key a name" };
  const { token } = await createApiKey({ companyId: account.id, name: parsed.data.name, scope: parsed.data.scope, createdBy: user.id, expiresInDays: Number(parsed.data.expires) || undefined });
  await audit(user.id, "apikey.created", "company", account.id, { name: parsed.data.name, scope: parsed.data.scope });
  revalidatePath(PATH);
  return { ok: `Copy the key now, it will not be shown again:\n${token}` };
}

export async function removeApiKey(form: FormData) {
  const { user, account } = await requireAccount("manage");
  await revokeApiKey(account.id, z.string().uuid().parse(form.get("id")));
  await audit(user.id, "apikey.revoked", "company", account.id);
  revalidatePath(PATH);
}

export async function newWebhook(_: ActionState, form: FormData): Promise<ActionState> {
  const { user, account } = await requireAccount("manage");
  try {
    const format = z.enum(["json", "slack", "discord", "telegram"]).catch("json").parse(form.get("format"));
    const { secret } = await createWebhook(account.id, { url: String(form.get("url") ?? ""), events: form.getAll("events").map(String), format, chatId: String(form.get("chatId") ?? "") });
    if (format !== "json") {
      await audit(user.id, "webhook.created", "company", account.id, { format });
      revalidatePath(PATH);
      return { ok: "Added. Press “Send test” to see a message arrive." };
    }
    await audit(user.id, "webhook.created", "company", account.id);
    revalidatePath(PATH);
    return { ok: `Signing secret, shown only now:\n${secret}` };
  } catch (err) {
    if (err instanceof WebhookError) return { error: err.message };
    throw err;
  }
}

export async function removeWebhook(form: FormData) {
  const { user, account } = await requireAccount("manage");
  await deleteWebhook(account.id, z.string().uuid().parse(form.get("id")));
  await audit(user.id, "webhook.deleted", "company", account.id);
  revalidatePath(PATH);
}

export async function pingWebhook(_: ActionState, form: FormData): Promise<ActionState> {
  const { account } = await requireAccount("manage");
  try {
    const status = await testWebhook(account.id, z.string().uuid().parse(form.get("id")));
    revalidatePath(PATH);
    return /^2/.test(status) ? { ok: `The endpoint answered ${status}` } : { error: `The endpoint answered: ${status}` };
  } catch (err) {
    if (err instanceof WebhookError) return { error: err.message };
    throw err;
  }
}
