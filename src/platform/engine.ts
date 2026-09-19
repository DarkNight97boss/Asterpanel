import "server-only";
import { generateKeyPairSync, createPrivateKey, randomBytes, sign } from "node:crypto";
import { and, asc, count, desc, eq, gt, inArray, lt, ne, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import type { WorkloadConfig, WorkloadType } from "@/db/schema";
import { audit } from "@/lib/audit";
import { decryptJson, encryptJson, randomToken } from "@/lib/crypto";
import { DOMAIN_RE, slugify } from "@/lib/format";
import { getSettings, updateSettings } from "@/lib/settings";
import {
  canonicalJson,
  PROTOCOL_VERSION,
  type JobEnvelope,
  type JobPayloads,
  type JobReport,
  type JobResult,
  type JobType,
  type PollRequest,
  type SignedJob,
  type ToolName,
  type WorkloadSpec,
} from "./protocol";

/**
 * The platform engine: everything that turns a click in the dashboard into
 * signed work for a node agent, and the agent's answer back into state.
 *
 * Rules of the road
 * - The database is the source of truth for *desired* state; agents converge.
 * - All mutations go through a job, so every change has a log and an outcome.
 * - Jobs of one workload never run concurrently (see `claimJobs`).
 */

export class PlatformError extends Error {}

const MINUTE = 60_000;
/** A node that has not polled for this long is considered offline. */
export const NODE_TIMEOUT_MS = 45_000;
const JOB_TTL_MS = 30 * MINUTE;

type Workload = typeof schema.workloads.$inferSelect;
type Secrets = { adminPassword?: string; dbPassword?: string; sftpPassword?: string; accessToken?: string; env?: Record<string, string> };

export const readSecrets = (w: Pick<Workload, "secrets">) => decryptJson<Secrets>(w.secrets, {});
const password = () => randomBytes(18).toString("base64url");

// ─── Signing ─────────────────────────────────────────────────────────────────

export async function signingKeys() {
  let { signingPrivateKey, signingPublicKey } = await getSettings("platform");
  if (!signingPrivateKey) {
    const pair = generateKeyPairSync("ed25519");
    signingPrivateKey = pair.privateKey.export({ type: "pkcs8", format: "der" }).toString("base64");
    signingPublicKey = pair.publicKey.export({ type: "spki", format: "der" }).toString("base64");
    await updateSettings("platform", { signingPrivateKey, signingPublicKey });
  }
  return {
    privateKey: createPrivateKey({ key: Buffer.from(signingPrivateKey, "base64"), type: "pkcs8", format: "der" }),
    /** Base64 SPKI DER — what agents pin as ASTER_PUBLIC_KEY. */
    publicKey: signingPublicKey,
  };
}

async function signEnvelope(envelope: JobEnvelope): Promise<SignedJob> {
  const { privateKey } = await signingKeys();
  return { envelope, signature: sign(null, Buffer.from(canonicalJson(envelope)), privateKey).toString("base64") };
}

// ─── Nodes ───────────────────────────────────────────────────────────────────

export const nodeIsOnline = (n: { status: string; lastSeenAt: Date | null }) =>
  n.status !== "disabled" && !!n.lastSeenAt && Date.now() - n.lastSeenAt.getTime() < NODE_TIMEOUT_MS;

/** Least-loaded online node (optionally in a region) that still has room. */
async function pickNode(region?: string) {
  const db = await getDb();
  const rows = await db
    .select({ node: schema.nodes, used: count(schema.workloads.id) })
    .from(schema.nodes)
    .leftJoin(schema.workloads, and(eq(schema.workloads.nodeId, schema.nodes.id), ne(schema.workloads.status, "deleted")))
    .where(and(ne(schema.nodes.status, "disabled"), region ? eq(schema.nodes.region, region) : undefined))
    .groupBy(schema.nodes.id);
  const free = rows
    .filter((r) => nodeIsOnline(r.node) && (r.node.maxWorkloads === 0 || r.used < r.node.maxWorkloads))
    .sort((a, b) => a.used - b.used);
  if (!free.length) throw new PlatformError(region ? "No server is available in this region right now" : "No server is available right now");
  return free[0].node;
}

// ─── Specs & jobs ────────────────────────────────────────────────────────────

export async function buildSpec(workloadId: string): Promise<WorkloadSpec> {
  const db = await getDb();
  const w = await db.query.workloads.findFirst({
    where: eq(schema.workloads.id, workloadId),
    with: { domains: { orderBy: [desc(schema.domains.isPrimary), asc(schema.domains.createdAt)] }, client: { columns: { email: true } } },
  });
  if (!w) throw new PlatformError("Workload not found");
  const secrets = readSecrets(w);
  const c = w.config;
  const dbSafe = w.slug.replace(/-/g, "_").slice(0, 32);

  return {
    id: w.id,
    slug: w.slug,
    kind: w.type,
    tenant: (w.companyId ?? w.clientId).replace(/-/g, "").slice(0, 12),
    environment: w.environment,
    domains: w.domains.map((d) => d.hostname),
    resources: { memoryMb: c.memoryMb ?? 512, cpus: c.cpus ?? 1, diskGb: c.diskGb ?? 10 },
    env: secrets.env,
    redirects: w.type === "database" ? undefined : c.redirects,
    denyIps: w.type === "database" ? undefined : c.denyIps,
    bots:
      w.type !== "database" && (c.botsBlockBad || c.botsBlockAi || c.botsRatePerMinute || c.botsProtectLogin)
        ? { blockBad: !!c.botsBlockBad, blockAi: !!c.botsBlockAi, ratePerMinute: c.botsRatePerMinute ?? 0, protectLogin: !!c.botsProtectLogin && w.type === "wordpress" }
        : undefined,
    cdn: w.type === "wordpress" && c.cdnEnabled ? { enabled: true, maxAgeDays: c.cdnMaxAgeDays ?? 30 } : undefined,
    cache: w.type === "wordpress" && c.cacheEnabled ? { enabled: true, ttlMinutes: c.cacheTtlMinutes ?? 60, bypass: c.cacheBypass ?? [] } : undefined,
    sftp: w.type === "wordpress" && c.sftpEnabled && c.sftpPort && secrets.sftpPassword ? { enabled: true, port: c.sftpPort, username: w.slug.replace(/-/g, "").slice(0, 24), password: secrets.sftpPassword, keys: (c.sftpKeys ?? []).map((k) => k.key) } : undefined,
    wordpress:
      w.type === "wordpress"
        ? {
            phpVersion: c.phpVersion ?? "8.3",
            title: w.name,
            adminUser: c.adminUser ?? "admin",
            adminEmail: c.adminEmail ?? w.client.email,
            adminPassword: secrets.adminPassword ?? "",
            dbPassword: secrets.dbPassword ?? "",
            locale: (await getSettings("general")).locale === "it" ? "it_IT" : "en_US",
          }
        : undefined,
    database:
      w.type === "database"
        ? { engine: c.engine ?? "mysql", version: c.version ?? "", name: dbSafe, user: dbSafe, password: secrets.dbPassword ?? "" }
        : undefined,
    source:
      w.type === "app" || w.type === "static"
        ? { repoUrl: c.repoUrl ?? "", branch: c.branch ?? "main", accessToken: secrets.accessToken, buildCommand: c.buildCommand, outputDir: c.outputDir, port: c.port }
        : undefined,
  };
}

async function enqueue<T extends JobType>(
  w: Pick<Workload, "id" | "nodeId">,
  type: T,
  payload: JobPayloads[T],
  refs: { backupId?: string; deploymentId?: string; actorId?: string | null } = {},
) {
  const db = await getDb();
  const [job] = await db
    .insert(schema.jobs)
    .values({ nodeId: w.nodeId, workloadId: w.id, type, payload: encryptJson(payload), ...refs })
    .returning({ id: schema.jobs.id });
  return job.id;
}

async function load(workloadId: string): Promise<Workload> {
  const db = await getDb();
  const w = await db.query.workloads.findFirst({ where: eq(schema.workloads.id, workloadId) });
  if (!w || w.status === "deleted") throw new PlatformError("Workload not found");
  return w;
}

const setStatus = async (id: string, status: Workload["status"], statusMessage = "") =>
  (await getDb()).update(schema.workloads).set({ status, statusMessage }).where(eq(schema.workloads.id, id));

// ─── Workload lifecycle ──────────────────────────────────────────────────────

export type NewWorkload = {
  clientId: string;
  companyId?: string | null;
  type: WorkloadType;
  name: string;
  config?: WorkloadConfig;
  serviceId?: string | null;
  region?: string;
  accessToken?: string;
  env?: Record<string, string>;
  actorId?: string | null;
};

export async function createWorkload(input: NewWorkload): Promise<string> {
  const name = input.name.trim().slice(0, 80);
  if (!name) throw new PlatformError("A name is required");
  const config = input.config ?? {};
  if ((input.type === "app" || input.type === "static") && !/^https:\/\/[^\s]+$/.test(config.repoUrl ?? "")) {
    throw new PlatformError("Enter the HTTPS URL of a Git repository");
  }

  const node = await pickNode(input.region);
  const slug = `${slugify(name).slice(0, 24).replace(/-+$/, "") || input.type}-${randomBytes(3).toString("hex")}`;
  const secrets: Secrets = { dbPassword: password(), env: input.env ?? {}, accessToken: input.accessToken || undefined };
  if (input.type === "wordpress") secrets.adminPassword = password();

  const db = await getDb();
  const workloadId = await db.transaction(async (tx) => {
    const [w] = await tx
      .insert(schema.workloads)
      .values({
        clientId: input.clientId,
        companyId: input.companyId ?? null,
        nodeId: node.id,
        serviceId: input.serviceId ?? null,
        type: input.type,
        name,
        slug,
        config,
        secrets: encryptJson(secrets),
        deployHookToken: input.type === "app" || input.type === "static" ? randomToken(24) : "",
      })
      .returning({ id: schema.workloads.id });
    // Databases are reached over the private network, not by hostname.
    if (input.type !== "database" && node.baseDomain) {
      await tx.insert(schema.domains).values({ workloadId: w.id, hostname: `${slug}.${node.baseDomain}`, isPrimary: true, isSystem: true });
    }
    return w.id;
  });

  const deploymentId = input.type === "app" || input.type === "static" ? await newDeployment(workloadId, "create") : undefined;
  await enqueue({ id: workloadId, nodeId: node.id }, "workload.create", { spec: await buildSpec(workloadId) }, { deploymentId, actorId: input.actorId });
  await audit(input.actorId ?? input.clientId, "workload.create", "workload", workloadId, { type: input.type, node: node.name });
  return workloadId;
}

async function newDeployment(workloadId: string, trigger: "manual" | "push" | "create") {
  const db = await getDb();
  const [d] = await db.insert(schema.deployments).values({ workloadId, trigger }).returning({ id: schema.deployments.id });
  return d.id;
}

type Power = "start" | "stop" | "restart";

export async function powerWorkload(workloadId: string, action: Power, actorId: string | null = null) {
  const w = await load(workloadId);
  if (w.status === "suspended" && action !== "stop") throw new PlatformError("This service is suspended");
  await enqueue(w, `workload.${action}`, { spec: await buildSpec(w.id) }, { actorId });
  await audit(actorId, `workload.${action}`, "workload", w.id);
}

/** Pushes the current desired state (domains, config, env) to the node. */
export async function applyWorkload(workloadId: string, actorId: string | null = null) {
  const w = await load(workloadId);
  await enqueue(w, "workload.update", { spec: await buildSpec(w.id) }, { actorId });
}

export async function updateWorkloadConfig(workloadId: string, patch: WorkloadConfig, actorId: string | null = null, env?: Record<string, string>) {
  const w = await load(workloadId);
  const db = await getDb();
  await db
    .update(schema.workloads)
    .set({ config: { ...w.config, ...patch }, ...(env ? { secrets: encryptJson({ ...readSecrets(w), env }) } : {}) })
    .where(eq(schema.workloads.id, w.id));
  await applyWorkload(w.id, actorId);
  await audit(actorId, "workload.update", "workload", w.id, { keys: Object.keys(patch), env: env ? Object.keys(env) : undefined });
}

export async function suspendWorkload(workloadId: string, reason: string, actorId: string | null = null) {
  const w = await load(workloadId);
  await setStatus(w.id, "suspended", reason);
  await enqueue(w, "workload.stop", { spec: await buildSpec(w.id) }, { actorId });
  for (const s of await stagingOf(w.id)) await suspendWorkload(s.id, reason, actorId);
}

export async function unsuspendWorkload(workloadId: string, actorId: string | null = null) {
  const w = await load(workloadId);
  await setStatus(w.id, "stopped");
  await enqueue(w, "workload.start", { spec: await buildSpec(w.id) }, { actorId });
}

export async function deleteWorkload(workloadId: string, actorId: string | null = null) {
  const w = await load(workloadId);
  for (const s of await stagingOf(w.id)) await deleteWorkload(s.id, actorId);
  await setStatus(w.id, "deleting");
  await enqueue(w, "workload.delete", { spec: await buildSpec(w.id) }, { actorId });
  await audit(actorId, "workload.delete", "workload", w.id);
}

async function stagingOf(liveId: string) {
  const db = await getDb();
  return db
    .select()
    .from(schema.workloads)
    .where(and(eq(schema.workloads.parentId, liveId), ne(schema.workloads.status, "deleted")));
}

// ─── Domains ─────────────────────────────────────────────────────────────────

export async function addDomain(workloadId: string, hostname: string, actorId: string | null = null) {
  const w = await load(workloadId);
  if (w.type === "database") throw new PlatformError("Databases do not have domains");
  const host = hostname.trim().toLowerCase().replace(/\.$/, "");
  if (!DOMAIN_RE.test(host)) throw new PlatformError("Enter a valid domain, e.g. example.com");
  const db = await getDb();
  const [row] = await db.insert(schema.domains).values({ workloadId: w.id, hostname: host }).onConflictDoNothing().returning();
  if (!row) throw new PlatformError("This domain is already in use");
  await applyWorkload(w.id, actorId);
  await audit(actorId, "domain.add", "workload", w.id, { hostname: host });
}

export async function removeDomain(workloadId: string, domainId: string, actorId: string | null = null) {
  const w = await load(workloadId);
  const db = await getDb();
  const [gone] = await db
    .delete(schema.domains)
    .where(and(eq(schema.domains.id, domainId), eq(schema.domains.workloadId, w.id), eq(schema.domains.isSystem, false)))
    .returning();
  if (!gone) throw new PlatformError("Domain not found");
  if (gone.isPrimary) {
    // Never leave a site without a primary hostname.
    const [next] = await db.select().from(schema.domains).where(eq(schema.domains.workloadId, w.id)).orderBy(desc(schema.domains.isSystem)).limit(1);
    if (next) await db.update(schema.domains).set({ isPrimary: true }).where(eq(schema.domains.id, next.id));
  }
  await applyWorkload(w.id, actorId);
  await audit(actorId, "domain.remove", "workload", w.id, { hostname: gone.hostname });
}

export async function setPrimaryDomain(workloadId: string, domainId: string, actorId: string | null = null) {
  const w = await load(workloadId);
  const db = await getDb();
  await db.transaction(async (tx) => {
    const [target] = await tx.select().from(schema.domains).where(and(eq(schema.domains.id, domainId), eq(schema.domains.workloadId, w.id)));
    if (!target) throw new PlatformError("Domain not found");
    await tx.update(schema.domains).set({ isPrimary: false }).where(eq(schema.domains.workloadId, w.id));
    await tx.update(schema.domains).set({ isPrimary: true }).where(eq(schema.domains.id, domainId));
  });
  await applyWorkload(w.id, actorId);
}

// ─── Backups ─────────────────────────────────────────────────────────────────

export async function createBackup(workloadId: string, note = "", kind: "manual" | "scheduled" | "system" = "manual", actorId: string | null = null) {
  const w = await load(workloadId);
  if (w.type === "static") throw new PlatformError("Static sites are rebuilt from Git and have no backups");
  const db = await getDb();
  const [b] = await db.insert(schema.backups).values({ workloadId: w.id, note: note.slice(0, 200), kind }).returning({ id: schema.backups.id });
  await enqueue(w, "backup.create", { spec: await buildSpec(w.id), backupId: b.id }, { backupId: b.id, actorId });
  return b.id;
}

async function backupOf(workloadId: string, backupId: string) {
  const db = await getDb();
  const [b] = await db.select().from(schema.backups).where(and(eq(schema.backups.id, backupId), eq(schema.backups.workloadId, workloadId)));
  if (!b || b.status !== "ready") throw new PlatformError("Backup not available");
  return b;
}

export async function restoreBackup(workloadId: string, backupId: string, actorId: string | null = null) {
  const w = await load(workloadId);
  const b = await backupOf(w.id, backupId);
  const db = await getDb();
  // Safety net first: jobs of one workload run in order, so this completes
  // before the restore starts.
  await createBackup(w.id, "Before restore", "system", actorId);
  await db.update(schema.backups).set({ status: "restoring" }).where(eq(schema.backups.id, b.id));
  await enqueue(w, "backup.restore", { spec: await buildSpec(w.id), backupId: b.id }, { backupId: b.id, actorId });
  await audit(actorId, "backup.restore", "workload", w.id, { backupId: b.id });
}

export async function deleteBackup(workloadId: string, backupId: string, actorId: string | null = null) {
  const w = await load(workloadId);
  const b = await backupOf(w.id, backupId);
  await enqueue(w, "backup.delete", { spec: await buildSpec(w.id), backupId: b.id }, { backupId: b.id, actorId });
}

// ─── Staging ─────────────────────────────────────────────────────────────────

export async function createStaging(liveId: string, actorId: string | null = null): Promise<string> {
  const live = await load(liveId);
  if (live.type !== "wordpress" || live.environment !== "live") throw new PlatformError("Staging is available for live WordPress sites");
  if ((await stagingOf(live.id)).length) throw new PlatformError("This site already has a staging environment");

  const db = await getDb();
  const [node] = await db.select().from(schema.nodes).where(eq(schema.nodes.id, live.nodeId));
  const slug = `stg-${live.slug}`.slice(0, 40);
  const secrets: Secrets = { ...readSecrets(live), dbPassword: password() };

  const stagingId = await db.transaction(async (tx) => {
    const [w] = await tx
      .insert(schema.workloads)
      .values({
        clientId: live.clientId,
        companyId: live.companyId,
        nodeId: live.nodeId, // same node: cloning is a local copy
        serviceId: live.serviceId,
        parentId: live.id,
        type: live.type,
        environment: "staging",
        name: `${live.name} (staging)`,
        slug,
        config: live.config,
        secrets: encryptJson(secrets),
      })
      .returning({ id: schema.workloads.id });
    if (node.baseDomain) await tx.insert(schema.domains).values({ workloadId: w.id, hostname: `${slug}.${node.baseDomain}`, isPrimary: true, isSystem: true });
    return w.id;
  });

  await enqueue({ id: stagingId, nodeId: live.nodeId }, "workload.clone", { spec: await buildSpec(stagingId), from: await buildSpec(live.id) }, { actorId });
  await audit(actorId, "staging.create", "workload", live.id, { stagingId });
  return stagingId;
}

/** Replaces live with staging's files and database, after a safety backup. */
export async function pushStagingToLive(stagingId: string, actorId: string | null = null) {
  const staging = await load(stagingId);
  if (staging.environment !== "staging" || !staging.parentId) throw new PlatformError("Not a staging environment");
  const live = await load(staging.parentId);
  await createBackup(live.id, "Before push from staging", "system", actorId);
  await enqueue(live, "workload.clone", { spec: await buildSpec(live.id), from: await buildSpec(staging.id) }, { actorId });
  await audit(actorId, "staging.push", "workload", live.id, { stagingId });
}

// ─── Deployments, tools, logs ────────────────────────────────────────────────

export async function deployWorkload(workloadId: string, trigger: "manual" | "push", actorId: string | null = null) {
  const w = await load(workloadId);
  if (w.type !== "app" && w.type !== "static") throw new PlatformError("This workload is not deployed from Git");
  if (w.status === "suspended") throw new PlatformError("This service is suspended");
  const deploymentId = await newDeployment(w.id, trigger);
  await enqueue(w, "workload.deploy", { spec: await buildSpec(w.id), deploymentId }, { deploymentId, actorId });
  return deploymentId;
}

export async function runTool(workloadId: string, tool: ToolName, args: Record<string, string> = {}, actorId: string | null = null) {
  const w = await load(workloadId);
  if (w.type !== "wordpress") throw new PlatformError("This tool is only available for WordPress");
  await audit(actorId, `tool.${tool}`, "workload", w.id);
  return enqueue(w, "workload.tool", { spec: await buildSpec(w.id), tool, args }, { actorId });
}

export async function requestLogs(workloadId: string, lines = 200) {
  const w = await load(workloadId);
  return enqueue(w, "workload.logs", { spec: await buildSpec(w.id), lines: Math.min(Math.max(lines, 10), 1000) });
}

// ─── Agent side ──────────────────────────────────────────────────────────────

export async function heartbeat(nodeId: string, poll: PollRequest) {
  const db = await getDb();
  await db
    .update(schema.nodes)
    .set({
      lastSeenAt: new Date(),
      driver: String(poll.driver ?? "").slice(0, 40),
      agentVersion: String(poll.agentVersion ?? "").slice(0, 40),
      stats: poll.stats ?? {},
      status: sql<schema.NodeStatus>`case when ${schema.nodes.status} = 'disabled' then 'disabled' else 'online' end`,
    })
    .where(eq(schema.nodes.id, nodeId));
}

const METRIC_EVERY_MS = 5 * MINUTE;
const METRIC_KEEP_MS = 7 * 24 * 60 * MINUTE;

/** Stores the agent's per-workload samples, thinned to one every few minutes. */
export async function recordMetrics(nodeId: string, samples: NonNullable<PollRequest["workloads"]>) {
  if (!Array.isArray(samples) || !samples.length) return;
  const db = await getDb();
  const rows = await db
    .select({ id: schema.workloads.id, slug: schema.workloads.slug })
    .from(schema.workloads)
    .where(and(eq(schema.workloads.nodeId, nodeId), ne(schema.workloads.status, "deleted")));
  const bySlug = new Map(rows.map((r) => [r.slug, r.id]));
  const num = (v: unknown) => Math.max(0, Math.min(2_000_000_000, Math.round(Number(v) || 0)));

  for (const sample of samples.slice(0, 500)) {
    const workloadId = bySlug.get(String(sample.slug));
    if (!workloadId) continue; // a node can only report its own workloads
    const [last] = await db.select({ at: schema.workloadMetrics.at }).from(schema.workloadMetrics).where(eq(schema.workloadMetrics.workloadId, workloadId)).orderBy(desc(schema.workloadMetrics.at)).limit(1);
    if (last && Date.now() - last.at.getTime() < METRIC_EVERY_MS) continue;
    await db.insert(schema.workloadMetrics).values({ workloadId, cpuPercent: num(sample.cpuPercent), memMb: num(sample.memMb), rxMb: num(sample.rxMb), txMb: num(sample.txMb) });
  }
  await db.delete(schema.workloadMetrics).where(lt(schema.workloadMetrics.at, new Date(Date.now() - METRIC_KEEP_MS)));
}

// ─── Edge rules ──────────────────────────────────────────────────────────────

const PATH_RE = /^\/[\w\-./~%+@:]{0,200}$/;
const IP_RE = /^(?:(?:\d{1,3}\.){3}\d{1,3}(?:\/(?:3[0-2]|[12]?\d))?|[0-9a-f:]{2,39}(?:\/(?:12[0-8]|1[01]\d|\d{1,2}))?)$/i;

export async function saveRedirects(workloadId: string, list: { from: string; to: string; code: number }[], actorId: string | null = null) {
  const clean = list.slice(0, 100).map((r) => {
    const from = r.from.trim();
    const to = r.to.trim();
    if (!PATH_RE.test(from)) throw new PlatformError(`Invalid source path: ${from.slice(0, 40)}`);
    if (!PATH_RE.test(to) && !/^https?:\/\/[^\s"'`<>]{3,300}$/.test(to)) throw new PlatformError(`Invalid destination: ${to.slice(0, 40)}`);
    if (from === to) throw new PlatformError("A redirect cannot point to itself");
    return { from, to, code: r.code === 302 ? (302 as const) : (301 as const) };
  });
  await updateWorkloadConfig(workloadId, { redirects: clean }, actorId);
}

export async function saveDenyIps(workloadId: string, ips: string[], actorId: string | null = null) {
  const clean = [...new Set(ips.map((ip) => ip.trim()).filter(Boolean))].slice(0, 200);
  for (const ip of clean) if (!IP_RE.test(ip) || ip.split(".").some((o) => /^\d+$/.test(o) && Number(o) > 255)) throw new PlatformError(`Invalid IP address or range: ${ip.slice(0, 45)}`);
  await updateWorkloadConfig(workloadId, { denyIps: clean }, actorId);
}

// ─── Edge cache ──────────────────────────────────────────────────────────────

export const CACHE_TTLS = [10, 60, 240, 1440, 10080] as const;

export async function saveCache(workloadId: string, input: { enabled: boolean; ttlMinutes: number; bypass: string[] }, actorId: string | null = null) {
  const w = await load(workloadId);
  if (w.type !== "wordpress") throw new PlatformError("Page caching is available for WordPress sites");
  const bypass = [...new Set(input.bypass.map((p) => p.trim()).filter(Boolean))].slice(0, 50);
  for (const p of bypass) if (!PATH_RE.test(p)) throw new PlatformError(`Invalid path: ${p.slice(0, 40)}`);
  const ttl = CACHE_TTLS.find((t) => t === input.ttlMinutes) ?? 60;
  await updateWorkloadConfig(w.id, { cacheEnabled: input.enabled, cacheTtlMinutes: ttl, cacheBypass: bypass }, actorId);
}

// ─── Bot protection, CDN, APM ────────────────────────────────────────────────

export async function saveBots(workloadId: string, input: { blockBad: boolean; blockAi: boolean; ratePerMinute: number; protectLogin: boolean }, actorId: string | null = null) {
  const w = await load(workloadId);
  if (w.type === "database") throw new PlatformError("Bot protection applies to web services");
  const rate = Math.round(input.ratePerMinute) || 0;
  if (rate !== 0 && (rate < 30 || rate > 100_000)) throw new PlatformError("The rate limit must be between 30 and 100000 requests per minute, or 0 to disable it");
  await updateWorkloadConfig(w.id, { botsBlockBad: input.blockBad, botsBlockAi: input.blockAi, botsRatePerMinute: rate, botsProtectLogin: input.protectLogin }, actorId);
}

export const CDN_MAX_AGES = [1, 7, 30, 365] as const;

export async function saveCdn(workloadId: string, input: { enabled: boolean; maxAgeDays: number }, actorId: string | null = null) {
  const w = await load(workloadId);
  if (w.type !== "wordpress") throw new PlatformError("Static asset acceleration is available for WordPress sites");
  await updateWorkloadConfig(w.id, { cdnEnabled: input.enabled, cdnMaxAgeDays: CDN_MAX_AGES.find((d) => d === input.maxAgeDays) ?? 30 }, actorId);
}

export const APM_RANGES = [15, 60, 360, 1440] as const;

export async function runApmJob(workloadId: string, minutes: number) {
  const w = await load(workloadId);
  if (w.type === "database") throw new PlatformError("Performance reports are available for web services");
  return enqueue(w, "workload.apm", { spec: await buildSpec(w.id), minutes: APM_RANGES.find((m) => m === minutes) ?? 60 });
}

// ─── File manager ────────────────────────────────────────────────────────────

/** Relative, normalised, no traversal. "" is the site root. */
export function cleanPath(input: string): string {
  const parts = input.replace(/\\/g, "/").split("/").filter((p) => p && p !== ".");
  if (parts.some((p) => p === ".." || /[\0-\x1f]/.test(p)) || parts.join("/").length > 1000) throw new PlatformError("Invalid path");
  return parts.join("/");
}

export const UPLOAD_LIMIT = 5 * 1024 * 1024;

export async function runFilesJob(workloadId: string, action: JobPayloads["workload.files"]["action"], path: string, content?: string, actorId: string | null = null, encoding: "utf8" | "base64" = "utf8") {
  const w = await load(workloadId);
  if (w.type !== "wordpress") throw new PlatformError("The file manager is available for WordPress sites");
  const clean = cleanPath(path);
  if (action !== "list" && !clean) throw new PlatformError("Invalid path");
  if (action === "write" && encoding === "utf8" && (content ?? "").length > 1_000_000) throw new PlatformError("This file is too large to edit here. Use SFTP.");
  if (action === "write" && encoding === "base64" && (content ?? "").length > Math.ceil((UPLOAD_LIMIT * 4) / 3) + 4) throw new PlatformError("Files up to 5 MB can be uploaded here. Use SFTP for larger ones.");
  if (action !== "list" && action !== "read") await audit(actorId, `files.${action}`, "workload", w.id, { path: clean });
  return enqueue(w, "workload.files", { spec: await buildSpec(w.id), action, path: clean, content: action === "write" ? (content ?? "") : undefined, encoding: action === "write" ? encoding : undefined }, { actorId });
}

// ─── DNS ─────────────────────────────────────────────────────────────────────

const HOST_RE = /^(?=.{1,253}$)([a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9_])?\.)+[a-z]{2,63}\.?$/i;
const LABELS_RE = /^(@|\*|(\*\.)?([a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9_])?)(\.[a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9_])?)*)$/i;

/** Validates and normalises one record. Throws a PlatformError the UI can show. */
export function cleanDnsRecord(input: { name: string; type: string; value: string; ttl: number; priority: number }) {
  const type = schema.DNS_TYPES.find((t) => t === input.type.toUpperCase());
  if (!type) throw new PlatformError("Unsupported record type");
  const name = (input.name.trim().toLowerCase() || "@").replace(/\.$/, "");
  if (!LABELS_RE.test(name)) throw new PlatformError("Invalid record name");
  let value = input.value.trim();
  const ipv4 = /^(\d{1,3})(\.\d{1,3}){3}$/.test(value) && value.split(".").every((o) => Number(o) <= 255);
  if (type === "A" && !ipv4) throw new PlatformError("An A record needs an IPv4 address");
  if (type === "AAAA" && !/^[0-9a-f:]{2,39}$/i.test(value)) throw new PlatformError("An AAAA record needs an IPv6 address");
  if (type === "CNAME" || type === "MX") {
    if (!HOST_RE.test(value)) throw new PlatformError("Enter a host name, e.g. mail.example.com");
    value = value.toLowerCase().replace(/\.?$/, ".");
    if (type === "CNAME" && name === "@") throw new PlatformError("A CNAME cannot be set on the root of the domain");
  }
  if (type === "TXT" && (!value || value.length > 2000 || /[\0-\x1f]/.test(value))) throw new PlatformError("Invalid TXT value");
  if (type === "CAA" && !/^\d{1,3} (issue|issuewild|iodef) "[^"\\\s]{1,200}"$/.test(value)) throw new PlatformError('A CAA record looks like: 0 issue "letsencrypt.org"');
  if (type === "SRV") {
    const m = /^(\d{1,5}) (\d{1,5}) (\S+)$/.exec(value);
    if (!m || !HOST_RE.test(m[3])) throw new PlatformError("An SRV record looks like: 10 5060 sip.example.com (weight port target)");
    value = `${m[1]} ${m[2]} ${m[3].toLowerCase().replace(/\.?$/, ".")}`;
  }
  const ttl = Math.min(Math.max(Math.round(input.ttl) || 3600, 60), 604_800);
  const priority = type === "MX" || type === "SRV" ? Math.min(Math.max(Math.round(input.priority) || 0, 0), 65_535) : 0;
  return { name, type, value, ttl, priority };
}

export async function createZone(clientId: string, domain: string, actorId: string | null = null, companyId: string | null = null): Promise<string> {
  const name = domain.trim().toLowerCase().replace(/\.$/, "");
  if (!DOMAIN_RE.test(name)) throw new PlatformError("Enter a valid domain, e.g. example.com");
  const db = await getDb();
  const [zone] = await db.insert(schema.dnsZones).values({ clientId, companyId, name }).onConflictDoNothing().returning();
  if (!zone) throw new PlatformError("This domain is already managed here");
  await audit(actorId, "dns.zone_created", "dns_zone", zone.id, { name });
  await syncDns();
  return zone.id;
}

/** Call after any change inside a zone: bumps the serial and pushes to the name servers. */
export async function touchZone(zoneId: string) {
  const db = await getDb();
  await db.update(schema.dnsZones).set({ serial: sql`${schema.dnsZones.serial} + 1` }).where(eq(schema.dnsZones.id, zoneId));
  await syncDns();
}

/** Every node is a name server: each gets the complete, current data set. Idempotent. */
export async function syncDns(): Promise<number> {
  const db = await getDb();
  const [dns, zones, nodes] = await Promise.all([
    getSettings("dns"),
    db.query.dnsZones.findMany({ with: { records: true }, orderBy: asc(schema.dnsZones.name) }),
    db.select().from(schema.nodes).where(ne(schema.nodes.status, "disabled")),
  ]);
  const payload: JobPayloads["dns.sync"] = {
    nameservers: dns.nameservers,
    hostmaster: dns.hostmaster,
    zones: zones.map((z) => ({ name: z.name, serial: z.serial, records: z.records.map(({ name, type, value, ttl, priority }) => ({ name, type, value, ttl, priority })) })),
  };
  for (const node of nodes) {
    // A newer full sync makes older queued ones pointless.
    await db.update(schema.jobs).set({ status: "cancelled", finishedAt: new Date() }).where(and(eq(schema.jobs.nodeId, node.id), eq(schema.jobs.type, "dns.sync"), eq(schema.jobs.status, "queued")));
    await db.insert(schema.jobs).values({ nodeId: node.id, type: "dns.sync", payload: encryptJson(payload) });
  }
  return nodes.length;
}

// ─── SFTP ────────────────────────────────────────────────────────────────────

const SFTP_PORTS = { from: 22000, to: 22999 };

export const sftpUsername = (slug: string) => slug.replace(/-/g, "").slice(0, 24);

/** Turns SFTP on (allocating a free port on the node and a password) or off. */
export async function setSftp(workloadId: string, enabled: boolean, actorId: string | null = null, rotate = false) {
  const w = await load(workloadId);
  if (w.type !== "wordpress") throw new PlatformError("SFTP is available for WordPress sites");
  const db = await getDb();
  let port = w.config.sftpPort;
  if (enabled && !port) {
    const siblings = await db.select({ config: schema.workloads.config }).from(schema.workloads).where(and(eq(schema.workloads.nodeId, w.nodeId), ne(schema.workloads.status, "deleted")));
    const used = new Set(siblings.map((r) => r.config.sftpPort));
    for (port = SFTP_PORTS.from; used.has(port); port++);
    if (port > SFTP_PORTS.to) throw new PlatformError("No SFTP port is free on this server");
  }
  const secrets = readSecrets(w);
  if (enabled && (rotate || !secrets.sftpPassword)) secrets.sftpPassword = password();
  await db.update(schema.workloads).set({ config: { ...w.config, sftpEnabled: enabled, sftpPort: port }, secrets: encryptJson(secrets) }).where(eq(schema.workloads.id, w.id));
  await applyWorkload(w.id, actorId);
  await audit(actorId, rotate ? "sftp.password_rotated" : enabled ? "sftp.enabled" : "sftp.disabled", "workload", w.id);
}

const SSH_KEY_RE = /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(?:256|384|521)|sk-ssh-ed25519@openssh\.com|sk-ecdsa-sha2-nistp256@openssh\.com) ([A-Za-z0-9+/]{60,1000}={0,3})( .*)?$/;

export async function addSftpKey(workloadId: string, name: string, publicKey: string, actorId: string | null = null) {
  const w = await load(workloadId);
  const match = SSH_KEY_RE.exec(publicKey.trim().replace(/\s+/g, " "));
  if (!match) throw new PlatformError("Paste an OpenSSH public key, e.g. ssh-ed25519 AAAA… (never a private key)");
  const key = `${match[1]} ${match[2]}`; // the comment is dropped: it is free text
  const keys = w.config.sftpKeys ?? [];
  if (keys.some((k) => k.key === key)) throw new PlatformError("This key is already authorised");
  if (keys.length >= 20) throw new PlatformError("Too many keys");
  await updateWorkloadConfig(w.id, { sftpKeys: [...keys, { name: name.trim().slice(0, 60) || "key", key }] }, actorId);
  await audit(actorId, "sftp.key_added", "workload", w.id, { name });
}

export async function removeSftpKey(workloadId: string, key: string, actorId: string | null = null) {
  const w = await load(workloadId);
  await updateWorkloadConfig(w.id, { sftpKeys: (w.config.sftpKeys ?? []).filter((k) => k.key !== key) }, actorId);
  await audit(actorId, "sftp.key_removed", "workload", w.id);
}

// ─── Database console ────────────────────────────────────────────────────────

export const isReadOnlySql = (sql: string) => /^\s*(select|show|describe|desc|explain|with|table|values)\b/i.test(sql) && !/;\s*\S/.test(sql.replace(/;\s*$/, ""));

export async function runDbJob(workloadId: string, action: "tables" | "query", sql = "", actorId: string | null = null) {
  const w = await load(workloadId);
  const engineName = w.type === "wordpress" ? "mysql" : w.type === "database" ? w.config.engine : undefined;
  if (engineName !== "mysql" && engineName !== "postgres") throw new PlatformError("The console is available for MySQL and PostgreSQL databases");
  const statement = sql.trim();
  if (action === "query" && (!statement || statement.length > 20_000)) throw new PlatformError("Enter one SQL statement");
  // The statement itself is the audit trail of what was run against customer data.
  if (action === "query") await audit(actorId, "db.query", "workload", w.id, { sql: statement.slice(0, 500), readOnly: isReadOnlySql(statement) });
  return enqueue(w, "workload.db", { spec: await buildSpec(w.id), action, sql: statement }, { actorId });
}

// ─── Scheduled backups ───────────────────────────────────────────────────────

const BACKUP_EVERY_MS = 24 * 60 * MINUTE;
const KEEP_SCHEDULED = 14;

/** Daily backup of every running site/database, keeping the most recent ones. Idempotent. */
export async function runScheduledBackups(now = new Date()): Promise<{ created: number; pruned: number }> {
  const db = await getDb();
  const targets = await db
    .select({ id: schema.workloads.id })
    .from(schema.workloads)
    .where(and(eq(schema.workloads.status, "running"), eq(schema.workloads.environment, "live"), inArray(schema.workloads.type, ["wordpress", "database"])));
  let created = 0;
  let pruned = 0;
  for (const { id } of targets) {
    const scheduled = await db.select().from(schema.backups).where(and(eq(schema.backups.workloadId, id), eq(schema.backups.kind, "scheduled"))).orderBy(desc(schema.backups.createdAt));
    if (!scheduled[0] || now.getTime() - scheduled[0].createdAt.getTime() >= BACKUP_EVERY_MS) {
      await createBackup(id, "", "scheduled");
      created++;
    }
    for (const old of scheduled.filter((b) => b.status === "ready").slice(KEEP_SCHEDULED - 1)) {
      await deleteBackup(id, old.id).catch(() => {});
      pruned++;
    }
  }
  return { created, pruned };
}

/** Hands out queued jobs, oldest first, never two for the same workload. */
export async function claimJobs(nodeId: string, capacity: number): Promise<SignedJob[]> {
  const db = await getDb();
  const now = Date.now();

  // An agent that died mid-job must not block its workloads forever.
  await db
    .update(schema.jobs)
    .set({ status: "failed", error: "Timed out: the agent never reported back", finishedAt: new Date() })
    .where(and(eq(schema.jobs.nodeId, nodeId), eq(schema.jobs.status, "running"), lt(schema.jobs.startedAt, new Date(now - JOB_TTL_MS))));

  const claimed = await db.transaction(async (tx) => {
    const running = await tx
      .select({ workloadId: schema.jobs.workloadId })
      .from(schema.jobs)
      .where(and(eq(schema.jobs.nodeId, nodeId), eq(schema.jobs.status, "running")));
    const busy = new Set(running.map((r) => r.workloadId));
    const queued = await tx
      .select()
      .from(schema.jobs)
      .where(and(eq(schema.jobs.nodeId, nodeId), eq(schema.jobs.status, "queued")))
      .orderBy(asc(schema.jobs.createdAt))
      .limit(50)
      .for("update");

    const take: typeof queued = [];
    for (const job of queued) {
      if (take.length >= capacity) break;
      if (busy.has(job.workloadId)) continue;
      busy.add(job.workloadId);
      take.push(job);
    }
    if (take.length) {
      await tx.update(schema.jobs).set({ status: "running", startedAt: new Date() }).where(inArray(schema.jobs.id, take.map((j) => j.id)));
    }
    return take;
  });

  return Promise.all(
    claimed.map((job) =>
      signEnvelope({
        v: PROTOCOL_VERSION,
        id: job.id,
        nodeId,
        type: job.type as JobType,
        payload: decryptJson<JobPayloads[JobType]>(job.payload, {} as JobPayloads[JobType]),
        issuedAt: now,
        expiresAt: now + JOB_TTL_MS,
      }),
    ),
  );
}

const MAX_LOG = 200_000;

export async function reportJob(nodeId: string, jobId: string, report: JobReport): Promise<boolean> {
  const db = await getDb();
  const [job] = await db.select().from(schema.jobs).where(and(eq(schema.jobs.id, jobId), eq(schema.jobs.nodeId, nodeId)));
  if (!job || job.status !== "running") return false;

  const log = (job.log + (report.log ?? "")).slice(-MAX_LOG);
  if (report.status === "running") {
    await db.update(schema.jobs).set({ log }).where(eq(schema.jobs.id, job.id));
    return true;
  }

  const ok = report.status === "succeeded";
  const result: JobResult = ok ? (report.result ?? {}) : {};
  const error = ok ? "" : String(report.error ?? "Failed").slice(0, 2000);
  // File contents and SQL have done their job: do not keep them in the queue.
  const scrubbed = job.type === "workload.files" ? encryptJson({ ...decryptJson<Record<string, unknown>>(job.payload, {}), content: undefined, spec: undefined }) : job.payload;
  await db.update(schema.jobs).set({ status: report.status, log, result, error, finishedAt: new Date(), payload: scrubbed }).where(eq(schema.jobs.id, job.id));
  await applyOutcome(job, ok, result, error);
  return true;
}

/** Folds a finished job back into workload / backup / deployment state. */
async function applyOutcome(job: typeof schema.jobs.$inferSelect, ok: boolean, result: JobResult, error: string) {
  const db = await getDb();
  const { workloads, backups, deployments, domains } = schema;
  const w = job.workloadId ? await db.query.workloads.findFirst({ where: eq(workloads.id, job.workloadId) }) : undefined;

  if (job.deploymentId) {
    await db
      .update(deployments)
      .set({ status: ok ? "live" : "failed", commitSha: result.commitSha ?? "", commitMessage: (result.commitMessage ?? "").slice(0, 300), finishedAt: new Date() })
      .where(eq(deployments.id, job.deploymentId));
  }
  if (job.backupId) {
    if (job.type === "backup.delete" && ok) await db.delete(backups).where(eq(backups.id, job.backupId));
    else if (job.type === "backup.create") await db.update(backups).set({ status: ok ? "ready" : "failed", sizeBytes: Math.round(result.sizeBytes ?? 0) }).where(eq(backups.id, job.backupId));
    else await db.update(backups).set({ status: "ready" }).where(eq(backups.id, job.backupId));
  }
  if (!w) return;

  const runtime = result.runtime ? { ...w.runtime, ...result.runtime } : w.runtime;
  const set = (status: Workload["status"], statusMessage = "") => db.update(workloads).set({ status, statusMessage, runtime }).where(eq(workloads.id, w.id));

  switch (job.type as JobType) {
    case "workload.create":
    case "workload.clone":
      await set(ok ? (w.status === "suspended" ? "suspended" : "running") : "error", error);
      break;
    case "workload.start":
    case "workload.restart":
    case "workload.update":
    case "backup.restore":
      if (ok && w.status !== "suspended") await set("running");
      else if (!ok) await db.update(workloads).set({ statusMessage: error }).where(eq(workloads.id, w.id));
      break;
    case "workload.deploy":
      // A failed build leaves the previous release serving traffic.
      if (ok && w.status !== "suspended") await set("running");
      break;
    case "workload.stop":
      if (ok && w.status !== "suspended") await set("stopped");
      break;
    case "workload.delete":
      if (ok) {
        await db.delete(domains).where(eq(domains.workloadId, w.id)); // frees the hostnames
        await set("deleted");
      } else await set("error", error);
      break;
    default:
      if (ok && result.runtime) await db.update(workloads).set({ runtime }).where(eq(workloads.id, w.id));
  }
}

/** Jobs still in flight for a workload — drives the "working…" UI state. */
export async function activeJobs(workloadId: string) {
  const db = await getDb();
  return db
    .select({ id: schema.jobs.id, type: schema.jobs.type, status: schema.jobs.status, createdAt: schema.jobs.createdAt })
    .from(schema.jobs)
    .where(and(eq(schema.jobs.workloadId, workloadId), inArray(schema.jobs.status, ["queued", "running"]), gt(schema.jobs.createdAt, new Date(Date.now() - 2 * JOB_TTL_MS))))
    .orderBy(asc(schema.jobs.createdAt));
}
