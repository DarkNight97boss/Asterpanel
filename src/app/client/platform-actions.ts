"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { ActionState } from "@/components/action-form";
import { getDb, schema } from "@/db";
import { BILLING_CYCLES, type WorkloadConfig } from "@/db/schema";
import { requireAccount } from "@/lib/account";
import { rateLimit } from "@/lib/rate-limit";
import { isStaff, requireArea } from "@/lib/auth";
import { BillingError, placeOrder, terminateService } from "@/lib/billing";
import { seedPlatformPlans } from "@/lib/install";
import { requestMeta } from "@/lib/request";
import { planType, sealRequestSecrets, type PlatformRequest } from "@/modules/provisioning/platform";
import { requireWorkload } from "@/platform/access";
import * as engine from "@/platform/engine";
import { TOOLS } from "@/platform/protocol";
import { WORKLOAD_LABEL } from "@/platform/ui";

const fail = (err: unknown): ActionState => {
  if (err instanceof engine.PlatformError || err instanceof BillingError) return { error: err.message };
  throw err;
};

/** `KEY=value` lines → object. Invalid names are rejected, not silently dropped. */
function parseEnv(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const at = line.indexOf("=");
    const key = line.slice(0, at).trim();
    if (at < 1 || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new engine.PlatformError(`Invalid environment variable: ${line.slice(0, 40)}`);
    env[key] = line.slice(at + 1).trim();
  }
  if (Object.keys(env).length > 100) throw new engine.PlatformError("Too many environment variables");
  return env;
}

const sourceConfig = z.object({
  repoUrl: z.string().trim().url().startsWith("https://", "Enter the HTTPS URL of a Git repository").max(300),
  branch: z.string().trim().regex(/^[\w./-]{1,200}$/, "Invalid branch name").default("main"),
  buildCommand: z.string().trim().max(500).default(""),
  outputDir: z.string().trim().regex(/^(?!\/)(?!.*\.\.)[\w./-]*$/, "Invalid output directory").max(200).default(""),
  port: z.coerce.number().int().min(1).max(65535).default(8080),
});

export async function createFromPlan(_: ActionState, form: FormData): Promise<ActionState> {
  const { account } = await requireAccount("manage");
  const f = Object.fromEntries(form);
  const base = z.object({ productId: z.string().uuid(), cycle: z.enum(BILLING_CYCLES), name: z.string().trim().min(2, "Give it a name").max(60), region: z.string().max(40).default("") }).safeParse(f);
  if (!base.success) return { error: base.error.issues[0].message };

  const db = await getDb();
  const product = await db.query.products.findFirst({ where: and(eq(schema.products.id, base.data.productId), eq(schema.products.module, "platform")) });
  if (!product) return { error: "Plan not available" };
  const type = planType(product.moduleConfig);

  let config: WorkloadConfig = {};
  let serviceId: string, invoiceId: string;
  try {
    if (type === "wordpress") {
      const wp = z.object({ phpVersion: z.enum(["8.1", "8.2", "8.3", "8.4"]), adminEmail: z.string().trim().email(), adminUser: z.string().trim().regex(/^[\w.@-]{3,40}$/, "Invalid admin username").default("admin") }).safeParse(f);
      if (!wp.success) return { error: wp.error.issues[0].message };
      config = wp.data;
    } else if (type === "database") {
      const d = z.object({ engine: z.enum(["mysql", "postgres", "redis"]), version: z.string().trim().regex(/^[\w.]{0,10}$/).default("") }).safeParse(f);
      if (!d.success) return { error: d.error.issues[0].message };
      config = d.data;
    } else {
      const src = sourceConfig.safeParse(f);
      if (!src.success) return { error: src.error.issues[0].message };
      config = type === "static" ? { repoUrl: src.data.repoUrl, branch: src.data.branch, buildCommand: src.data.buildCommand, outputDir: src.data.outputDir } : { repoUrl: src.data.repoUrl, branch: src.data.branch, port: src.data.port };
    }
    const request: PlatformRequest = {
      name: base.data.name,
      region: base.data.region,
      config,
      sealed: sealRequestSecrets({ env: parseEnv(String(f.env ?? "")), accessToken: String(f.accessToken ?? "").trim() || undefined }),
    };
    ({ serviceId, invoiceId } = await placeOrder({ clientId: account.ownerUserId, companyId: account.id, productId: product.id, cycle: base.data.cycle, domain: "", ip: (await requestMeta()).ip, request, coupon: String(f.coupon ?? "").slice(0, 40) }));
  } catch (err) {
    return fail(err);
  }

  // Free plans are provisioned on the spot; paid ones after the invoice.
  const service = await db.query.services.findFirst({ where: eq(schema.services.id, serviceId) });
  const workloadId = service?.moduleData.workloadId;
  redirect(typeof workloadId === "string" ? `/client/workloads/${workloadId}` : `/client/invoices/${invoiceId}`);
}

export async function seedPlans() {
  await requireArea("billing");
  await seedPlatformPlans();
  revalidatePath("/client", "layout");
}

// ─── Workload actions (every one re-checks access) ───────────────────────────

const refresh = (id: string) => revalidatePath(`/client/workloads/${id}`, "layout");

export async function power(_: ActionState, form: FormData): Promise<ActionState> {
  const { user, workload } = await requireWorkload(String(form.get("id")));
  const action = z.enum(["start", "stop", "restart"]).parse(form.get("action"));
  try {
    await engine.powerWorkload(workload.id, action, user.id);
  } catch (err) {
    return fail(err);
  }
  refresh(workload.id);
}

export async function addDomain(_: ActionState, form: FormData): Promise<ActionState> {
  const { user, workload } = await requireWorkload(String(form.get("id")));
  try {
    await engine.addDomain(workload.id, String(form.get("hostname") ?? ""), user.id);
  } catch (err) {
    return fail(err);
  }
  refresh(workload.id);
}

export async function domainAction(form: FormData) {
  const { user, workload } = await requireWorkload(String(form.get("id")));
  const domainId = z.string().uuid().parse(form.get("domainId"));
  if (form.get("action") === "primary") await engine.setPrimaryDomain(workload.id, domainId, user.id);
  else await engine.removeDomain(workload.id, domainId, user.id);
  refresh(workload.id);
}

export async function createBackup(_: ActionState, form: FormData): Promise<ActionState> {
  const { user, workload } = await requireWorkload(String(form.get("id")));
  try {
    await engine.createBackup(workload.id, String(form.get("note") ?? ""), "manual", user.id);
  } catch (err) {
    return fail(err);
  }
  refresh(workload.id);
}

export async function backupAction(_: ActionState, form: FormData): Promise<ActionState> {
  const { user, workload } = await requireWorkload(String(form.get("id")));
  const backupId = z.string().uuid().parse(form.get("backupId"));
  try {
    if (form.get("action") === "restore") await engine.restoreBackup(workload.id, backupId, user.id);
    else await engine.deleteBackup(workload.id, backupId, user.id);
  } catch (err) {
    return fail(err);
  }
  refresh(workload.id);
}

export async function staging(_: ActionState, form: FormData): Promise<ActionState> {
  const { user, workload } = await requireWorkload(String(form.get("id")));
  let target = workload.id;
  try {
    const action = form.get("action");
    if (action === "create") target = await engine.createStaging(workload.id, user.id);
    else if (action === "push") {
      await engine.pushStagingToLive(workload.id, user.id);
      target = workload.parentId ?? workload.id;
    } else {
      await engine.deleteWorkload(workload.id, user.id);
      target = workload.parentId ?? workload.id;
    }
  } catch (err) {
    return fail(err);
  }
  redirect(`/client/workloads/${target}`);
}

export async function deploy(_: ActionState, form: FormData): Promise<ActionState> {
  const { user, workload } = await requireWorkload(String(form.get("id")));
  try {
    await engine.deployWorkload(workload.id, "manual", user.id);
  } catch (err) {
    return fail(err);
  }
  refresh(workload.id);
}

export async function migrate(_: ActionState, form: FormData): Promise<ActionState> {
  const { user, workload, canManage } = await requireWorkload(String(form.get("id")));
  if (!canManage) return { error: "Only owners and administrators can migrate a site" };
  if (!rateLimit(`migrate:${workload.id}`, 6, 60 * 60_000)) return { error: "Too many attempts. Try again in a few minutes." };
  const f = (k: string) => String(form.get(k) ?? "");
  try {
    await engine.startMigration(workload.id, { type: f("type"), url: f("url"), host: f("host"), port: f("port"), user: f("user"), password: f("password"), path: f("path") }, user.id);
  } catch (err) {
    return fail(err);
  }
  refresh(workload.id);
  return { ok: "Migration started. A safety backup is taken first." };
}

export async function rollback(_: ActionState, form: FormData): Promise<ActionState> {
  const { user, workload } = await requireWorkload(String(form.get("id")));
  try {
    await engine.rollbackDeployment(workload.id, String(form.get("deploymentId")), user.id);
  } catch (err) {
    return fail(err);
  }
  refresh(workload.id);
}

export async function runTool(_: ActionState, form: FormData): Promise<ActionState> {
  const { user, workload } = await requireWorkload(String(form.get("id")));
  const tool = z.enum(TOOLS).parse(form.get("tool"));
  const args = { search: String(form.get("search") ?? "").slice(0, 300), replace: String(form.get("replace") ?? "").slice(0, 300) };
  if (tool === "wp.search_replace" && (!args.search || !args.replace)) return { error: "Both search and replace are required" };
  const update = { kind: z.enum(["plugin", "theme", "core"]).catch("plugin").parse(form.get("kind")), name: String(form.get("name") ?? "").slice(0, 100) };
  if (update.name && !/^[\w.-]+$/.test(update.name)) return { error: "Invalid request" };
  try {
    await engine.runTool(workload.id, tool, tool === "wp.search_replace" ? args : tool === "wp.update" ? update : {}, user.id);
    // Refresh the list right after an update so the page shows the new versions.
    if (tool === "wp.update") await engine.runTool(workload.id, "wp.inventory", {}, user.id);
  } catch (err) {
    return fail(err);
  }
  refresh(workload.id);
  return { ok: "Started. The result appears below in a few seconds." };
}

export async function fetchLogs(form: FormData) {
  const { workload } = await requireWorkload(String(form.get("id")));
  const jobId = await engine.requestLogs(workload.id, 300);
  redirect(`/client/workloads/${workload.id}/logs?job=${jobId}`);
}

export async function saveSettings(_: ActionState, form: FormData): Promise<ActionState> {
  const { user, workload } = await requireWorkload(String(form.get("id")));
  const f = Object.fromEntries(form);
  try {
    const name = z.string().trim().min(2).max(60).parse(f.name);
    const db = await getDb();
    const labels = [...new Set(String(f.labels ?? "").split(",").map((l) => l.trim().toLowerCase().replace(/[^\p{L}\p{N} ._-]/gu, "").slice(0, 30)).filter(Boolean))].slice(0, 10);
    await db.update(schema.workloads).set({ name, labels }).where(eq(schema.workloads.id, workload.id));

    if (workload.type === "wordpress") {
      const phpVersion = z.enum(["8.1", "8.2", "8.3", "8.4"]).parse(f.phpVersion);
      if (phpVersion !== workload.config.phpVersion) await engine.updateWorkloadConfig(workload.id, { phpVersion }, user.id);
    } else if (workload.type === "app" || workload.type === "static") {
      const src = sourceConfig.safeParse(f);
      if (!src.success) return { error: src.error.issues[0].message };
      const { port, ...rest } = src.data;
      await engine.updateWorkloadConfig(workload.id, workload.type === "app" ? { ...rest, port } : rest, user.id, parseEnv(String(f.env ?? "")));
    }
  } catch (err) {
    if (err instanceof z.ZodError) return { error: err.issues[0].message };
    return fail(err);
  }
  refresh(workload.id);
  return { ok: "Saved" };
}

export async function destroy(_: ActionState, form: FormData): Promise<ActionState> {
  const { user, workload, canManage } = await requireWorkload(String(form.get("id")));
  if (!canManage) return { error: "Your role cannot delete services" };
  if (String(form.get("confirm") ?? "").trim() !== workload.name) return { error: "Type the exact name to confirm" };
  try {
    // A billed workload ends through its service, so renewals stop too.
    if (workload.serviceId && workload.environment === "live") await terminateService(workload.serviceId, user.id);
    else await engine.deleteWorkload(workload.id, user.id);
  } catch (err) {
    return fail(err);
  }
  redirect(isStaff(user) && workload.clientId !== user.id ? "/admin/workloads" : WORKLOAD_LABEL[workload.type].path);
}

export async function addRedirect(_: ActionState, form: FormData): Promise<ActionState> {
  const { user, workload } = await requireWorkload(String(form.get("id")));
  const rule = { from: String(form.get("from") ?? ""), to: String(form.get("to") ?? ""), code: Number(form.get("code")) };
  try {
    await engine.saveRedirects(workload.id, [...(workload.config.redirects ?? []).filter((r) => r.from !== rule.from.trim()), rule], user.id);
  } catch (err) {
    return fail(err);
  }
  refresh(workload.id);
}

export async function removeRedirect(form: FormData) {
  const { user, workload } = await requireWorkload(String(form.get("id")));
  await engine.saveRedirects(workload.id, (workload.config.redirects ?? []).filter((r) => r.from !== form.get("from")), user.id);
  refresh(workload.id);
}

export async function saveDenyList(_: ActionState, form: FormData): Promise<ActionState> {
  const { user, workload } = await requireWorkload(String(form.get("id")));
  try {
    await engine.saveDenyIps(workload.id, String(form.get("ips") ?? "").split(/[\s,;]+/), user.id);
  } catch (err) {
    return fail(err);
  }
  refresh(workload.id);
  return { ok: "Saved" };
}

export async function sftpAction(_: ActionState, form: FormData): Promise<ActionState> {
  const { user, workload } = await requireWorkload(String(form.get("id")));
  const action = z.enum(["enable", "disable", "rotate"]).parse(form.get("action"));
  try {
    await engine.setSftp(workload.id, action !== "disable", user.id, action === "rotate");
  } catch (err) {
    return fail(err);
  }
  refresh(workload.id);
}

export async function dbConsole(_: ActionState, form: FormData): Promise<ActionState> {
  const { user, workload } = await requireWorkload(String(form.get("id")));
  const sql = String(form.get("sql") ?? "");
  const action = form.get("action") === "tables" ? "tables" : "query";
  if (action === "query" && !engine.isReadOnlySql(sql) && !form.has("confirmWrite")) {
    return { error: "This statement can change or delete data. Tick the confirmation box to run it." };
  }
  let jobId: string;
  try {
    jobId = await engine.runDbJob(workload.id, action, sql, user.id);
  } catch (err) {
    return fail(err);
  }
  redirect(`/client/workloads/${workload.id}/database?job=${jobId}`);
}

export async function saveCaching(_: ActionState, form: FormData): Promise<ActionState> {
  const { user, workload } = await requireWorkload(String(form.get("id")));
  try {
    await engine.saveCache(workload.id, { enabled: form.has("enabled"), ttlMinutes: Number(form.get("ttl")), bypass: String(form.get("bypass") ?? "").split(/\r?\n/) }, user.id);
  } catch (err) {
    return fail(err);
  }
  refresh(workload.id);
  return { ok: "Saved" };
}

/** Every file-manager interaction is a job; the page then shows its result. */
export async function filesAction(_: ActionState, form: FormData): Promise<ActionState> {
  const { user, workload } = await requireWorkload(String(form.get("id")));
  const action = z.enum(["list", "read", "write", "mkdir", "delete"]).parse(form.get("action"));
  const dir = String(form.get("dir") ?? "");
  const name = String(form.get("name") ?? "").trim();
  if ((action === "mkdir" || (action === "write" && form.has("name"))) && !/^[^/\\\0]{1,200}$/.test(name)) return { error: "Enter a valid name" };
  const path = form.has("name") ? `${dir}/${name}` : String(form.get("path") ?? "");
  let jobId: string;
  try {
    jobId = await engine.runFilesJob(workload.id, action, path, String(form.get("content") ?? ""), user.id);
    // After a change, show the folder it happened in.
    if (action !== "list" && action !== "read") jobId = await engine.runFilesJob(workload.id, "list", action === "mkdir" || form.has("name") ? dir : path.split("/").slice(0, -1).join("/"), undefined, user.id);
  } catch (err) {
    return fail(err);
  }
  redirect(`/client/workloads/${workload.id}/files?job=${jobId}`);
}

export async function saveBotProtection(_: ActionState, form: FormData): Promise<ActionState> {
  const { user, workload } = await requireWorkload(String(form.get("id")));
  try {
    await engine.saveBots(workload.id, { blockBad: form.has("blockBad"), blockAi: form.has("blockAi"), protectLogin: form.has("protectLogin"), ratePerMinute: Number(form.get("rate")) }, user.id);
  } catch (err) {
    return fail(err);
  }
  refresh(workload.id);
  return { ok: "Saved" };
}

export async function saveCdnSettings(_: ActionState, form: FormData): Promise<ActionState> {
  const { user, workload } = await requireWorkload(String(form.get("id")));
  try {
    await engine.saveCdn(workload.id, { enabled: form.has("enabled"), maxAgeDays: Number(form.get("maxAge")) }, user.id);
  } catch (err) {
    return fail(err);
  }
  refresh(workload.id);
  return { ok: "Saved" };
}

export async function analysePerformance(form: FormData) {
  const { workload } = await requireWorkload(String(form.get("id")));
  const jobId = await engine.runApmJob(workload.id, Number(form.get("minutes")));
  redirect(`/client/workloads/${workload.id}/apm?job=${jobId}`);
}

export async function sftpKeyAction(_: ActionState, form: FormData): Promise<ActionState> {
  const { user, workload } = await requireWorkload(String(form.get("id")));
  try {
    if (form.get("action") === "remove") await engine.removeSftpKey(workload.id, String(form.get("key") ?? ""), user.id);
    else await engine.addSftpKey(workload.id, String(form.get("name") ?? ""), String(form.get("publicKey") ?? ""), user.id);
  } catch (err) {
    return fail(err);
  }
  refresh(workload.id);
}

export async function uploadFile(_: ActionState, form: FormData): Promise<ActionState> {
  const { user, workload } = await requireWorkload(String(form.get("id")));
  const file = form.get("file");
  const dir = String(form.get("dir") ?? "");
  if (!(file instanceof File) || !file.size) return { error: "Choose a file to upload" };
  if (file.size > engine.UPLOAD_LIMIT) return { error: "Files up to 5 MB can be uploaded here. Use SFTP for larger ones." };
  // The browser-supplied name is untrusted: keep only its last segment.
  const name = file.name.split(/[\\/]/).pop()!.replace(/[\0-\x1f]/g, "").trim();
  if (!name || name === "." || name === "..") return { error: "Enter a valid name" };
  let jobId: string;
  try {
    await engine.runFilesJob(workload.id, "write", `${dir}/${name}`, Buffer.from(await file.arrayBuffer()).toString("base64"), user.id, "base64");
    jobId = await engine.runFilesJob(workload.id, "list", dir, undefined, user.id);
  } catch (err) {
    return fail(err);
  }
  redirect(`/client/workloads/${workload.id}/files?job=${jobId}`);
}
