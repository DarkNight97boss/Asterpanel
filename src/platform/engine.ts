import "server-only";
import { generateKeyPairSync, createPrivateKey, randomBytes, sign, createHash } from "node:crypto";
import { and, asc, count, desc, eq, gt, inArray, lt, ne, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import type { WorkloadConfig, WorkloadType } from "@/db/schema";
import { audit } from "@/lib/audit";
import { parseCronLines, type CronJob } from "./cron";
import { publicHttpsUrl } from "@/lib/net";
import { emitEvent } from "@/lib/webhooks";
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
  type MigrationSource,
  type OffsiteTarget,
  type PollRequest,
  type SignedJob,
  type ToolName,
  type WorkloadSpec,
  type WpScan,
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
type Secrets = { sitePassword?: string; adminPassword?: string; dbPassword?: string; sftpPassword?: string; accessToken?: string; env?: Record<string, string> };

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

/** The given node, if it is online and has room for one more workload. */
async function nodeWithRoom(nodeId: string) {
  const db = await getDb();
  const [row] = await db
    .select({ node: schema.nodes, used: count(schema.workloads.id) })
    .from(schema.nodes)
    .leftJoin(schema.workloads, and(eq(schema.workloads.nodeId, schema.nodes.id), ne(schema.workloads.status, "deleted")))
    .where(eq(schema.nodes.id, nodeId))
    .groupBy(schema.nodes.id);
  if (!row || !nodeIsOnline(row.node) || (row.node.maxWorkloads > 0 && row.used >= row.node.maxWorkloads)) throw new PlatformError("The server of the original site has no room for a copy right now");
  return row.node;
}

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
  if (free.length) return free[0].node;
  // Automatic mode: a server is created at the cloud provider and the workload waits on it;
  // its jobs are picked up as soon as the new machine's agent comes online.
  const { autoscaleNode } = await import("@/lib/cloud");
  const fresh = await autoscaleNode(region).catch(() => null);
  if (fresh) return fresh;
  throw new PlatformError(region ? "No server is available in this region right now" : "No server is available right now");
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
    // Shared groups first, the service's own variables on top: the more specific value wins.
    env: { ...(await groupEnv(w.companyId, c.envGroupIds)), ...secrets.env },
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
            php: c.php,
            objectCache: c.objectCache || undefined,
            systemCron: c.systemCron || undefined,
          }
        : undefined,
    database:
      w.type === "database"
        ? { engine: c.engine ?? "mysql", version: c.version ?? "", name: dbSafe, user: dbSafe, password: secrets.dbPassword ?? "" }
        : undefined,
    crons: w.type === "app" && w.environment === "live" ? c.crons : w.type === "wordpress" && c.systemCron ? [{ schedule: "*/5 * * * *", command: "cd /var/www/html && php wp-cron.php" }] : undefined,
    edge:
      w.type !== "database" && (c.hsts || (c.sitePasswordUser && secrets.sitePassword))
        ? { hsts: c.hsts || undefined, basicAuth: c.sitePasswordUser && secrets.sitePassword ? { user: c.sitePasswordUser, hash: `{SHA}${createHash("sha1").update(secrets.sitePassword).digest("base64")}` } : undefined }
        : undefined,
    source:
      w.type === "app" || w.type === "static"
        ? { repoUrl: c.repoUrl ?? "", branch: c.branch ?? "main", accessToken: secrets.accessToken, buildCommand: c.buildCommand, outputDir: c.outputDir, port: c.port, image: w.type === "app" ? c.image : undefined, healthPath: c.healthPath }
        : undefined,
  };
}

/**
 * Spec for a job that clones the repository. When the workload is connected
 * through the GitHub App, a fresh one-hour token for that repository replaces
 * any saved one: nothing long-lived has to be stored for private repositories.
 */
async function specForBuild(w: Pick<Workload, "id" | "githubInstallationId" | "githubRepo">): Promise<WorkloadSpec> {
  const spec = await buildSpec(w.id);
  if (w.githubInstallationId && w.githubRepo && spec.source) {
    const { installationToken } = await import("@/lib/github");
    spec.source.accessToken = await installationToken(w.githubInstallationId, w.githubRepo).catch(() => spec.source!.accessToken);
  }
  return spec;
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
  /** WordPress only: start as a copy of this site (same company, same server). */
  cloneFrom?: string;
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
  if (input.type === "app" && config.image) config.image = cleanImage(config.image);
  else if ((input.type === "app" || input.type === "static") && !/^https:\/\/[^\s]+$/.test(config.repoUrl ?? "")) {
    throw new PlatformError("Enter the HTTPS URL of a Git repository");
  }

  // A copy is made locally on the node, so the new site has to live where the original does.
  const source = input.cloneFrom ? await load(input.cloneFrom) : null;
  if (source && (source.type !== "wordpress" || input.type !== "wordpress" || source.status !== "running" || (source.companyId ?? null) !== (input.companyId ?? null))) throw new PlatformError("This site cannot be copied");
  const node = source ? await nodeWithRoom(source.nodeId) : await pickNode(input.region);
  const slug = `${slugify(name).slice(0, 24).replace(/-+$/, "") || input.type}-${randomBytes(3).toString("hex")}`;
  const secrets: Secrets = { dbPassword: password(), env: input.env ?? {}, accessToken: input.accessToken || undefined };
  // A copy keeps the users of the original, so the admin login shown in the panel is the original's.
  if (input.type === "wordpress") secrets.adminPassword = source ? (readSecrets(source).adminPassword ?? password()) : password();
  if (source) Object.assign(config, { adminUser: source.config.adminUser, adminEmail: source.config.adminEmail, phpVersion: source.config.phpVersion, php: source.config.php });

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
  if (source) await enqueue({ id: workloadId, nodeId: node.id }, "workload.clone", { spec: await buildSpec(workloadId), from: await buildSpec(source.id) }, { actorId: input.actorId });
  await audit(input.actorId ?? input.clientId, "workload.create", "workload", workloadId, { type: input.type, node: node.name, copyOf: source?.id });
  return workloadId;
}

async function newDeployment(workloadId: string, trigger: "manual" | "push" | "create" | "rollback", extra: Partial<typeof schema.deployments.$inferInsert> = {}) {
  const db = await getDb();
  const [d] = await db.insert(schema.deployments).values({ ...extra, workloadId, trigger }).returning({ id: schema.deployments.id });
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
  const offsite = await offsiteTarget();
  const [b] = await db.insert(schema.backups).values({ workloadId: w.id, note: note.slice(0, 200), kind, offsite: offsite ? "pending" : "none" }).returning({ id: schema.backups.id });
  await enqueue(w, "backup.create", { spec: await buildSpec(w.id), backupId: b.id, offsite }, { backupId: b.id, actorId });
  return b.id;
}

/** The configured object storage, or undefined when off-site backups are off or incomplete. */
export async function offsiteTarget(): Promise<OffsiteTarget | undefined> {
  const s = await getSettings("backups");
  if (!s.offsiteEnabled || !s.bucket || !s.accessKey || !s.secretKey) return undefined;
  return { endpoint: s.endpoint, region: s.region, bucket: s.bucket, prefix: s.prefix.replace(/^\/+|\/+$/g, ""), accessKey: s.accessKey, secretKey: s.secretKey, keepLocal: s.keepLocal };
}

/** Asks a node to write, read and delete a probe object with the saved settings. Returns the job id. */
export async function testOffsite(nodeId: string, actorId: string | null = null): Promise<string> {
  const offsite = await offsiteTarget();
  if (!offsite) throw new PlatformError("Enable off-site backups and fill in bucket and keys first");
  const db = await getDb();
  const [node] = await db.select().from(schema.nodes).where(eq(schema.nodes.id, nodeId));
  if (!node || !nodeIsOnline(node)) throw new PlatformError("This server is offline");
  const [job] = await db.insert(schema.jobs).values({ nodeId: node.id, type: "offsite.test", payload: encryptJson({ offsite }), actorId }).returning({ id: schema.jobs.id });
  return job.id;
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
  await enqueue(w, "backup.restore", { spec: await buildSpec(w.id), backupId: b.id, offsite: b.offsite === "uploaded" ? await offsiteTarget() : undefined }, { backupId: b.id, actorId });
  await audit(actorId, "backup.restore", "workload", w.id, { backupId: b.id });
}

export async function deleteBackup(workloadId: string, backupId: string, actorId: string | null = null) {
  const w = await load(workloadId);
  const b = await backupOf(w.id, backupId);
  await enqueue(w, "backup.delete", { spec: await buildSpec(w.id), backupId: b.id, offsite: b.offsite === "uploaded" ? await offsiteTarget() : undefined }, { backupId: b.id, actorId });
}

// ─── Staging ─────────────────────────────────────────────────────────────────

export const MAX_STAGING = 3;

export async function createStaging(liveId: string, actorId: string | null = null, label = ""): Promise<string> {
  const live = await load(liveId);
  if (live.type !== "wordpress" || live.environment !== "live") throw new PlatformError("Staging is available for live WordPress sites");
  const existing = (await stagingOf(live.id)).filter((s) => s.environment === "staging");
  if (existing.length >= MAX_STAGING) throw new PlatformError(`A site can have up to ${MAX_STAGING} staging environments`);

  const db = await getDb();
  const [node] = await db.select().from(schema.nodes).where(eq(schema.nodes.id, live.nodeId));
  // The first keeps the plain name (and its address); further ones get a suffix.
  const slug = `${existing.length ? `stg${existing.length + 1}` : "stg"}-${live.slug}`.slice(0, 40);
  const tag = label.trim().replace(/[^\p{L}\p{N} ._-]/gu, "").slice(0, 30);
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
        name: tag ? `${live.name} (staging: ${tag})` : `${live.name} (staging)`,
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
/** `scope`: everything, only the files (theme and plugin work), or only the database (content work). */
export async function pushStagingToLive(stagingId: string, actorId: string | null = null, scope: "all" | "files" | "database" = "all") {
  const staging = await load(stagingId);
  if (staging.environment !== "staging" || !staging.parentId) throw new PlatformError("Not a staging environment");
  const live = await load(staging.parentId);
  await createBackup(live.id, "Before push from staging", "system", actorId);
  await enqueue(live, "workload.clone", { spec: await buildSpec(live.id), from: await buildSpec(staging.id), scope }, { actorId });
  await audit(actorId, "staging.push", "workload", live.id, { stagingId, scope });
}

// ─── Deployments, tools, logs ────────────────────────────────────────────────

export async function deployWorkload(workloadId: string, trigger: "manual" | "push", actorId: string | null = null) {
  const w = await load(workloadId);
  if (w.type !== "app" && w.type !== "static") throw new PlatformError("This workload is not deployed from Git");
  if (w.status === "suspended") throw new PlatformError("This service is suspended");
  const deploymentId = await newDeployment(w.id, trigger);
  const keepImages = (await rollbackCandidates(w.id)).slice(0, ROLLBACK_DEPTH - 1).map((d) => d.id);
  await enqueue(w, "workload.deploy", { spec: await specForBuild(w), deploymentId, keepImages }, { deploymentId, actorId });
  return deploymentId;
}

// ─── Preview environments ────────────────────────────────────────────────────

export const MAX_PREVIEWS = 3;
const BRANCH = /^(?!-)[\w./-]{1,200}$/;

/** What a Git provider told us about a push. GitHub and GitLab both send `ref`; a deleted branch has an all-zero `after`. */
export function parsePush(body: unknown): { branch: string; deleted: boolean } | null {
  const b = (body ?? {}) as { ref?: unknown; deleted?: unknown; after?: unknown };
  const ref = typeof b.ref === "string" ? /^refs\/heads\/(.+)$/.exec(b.ref)?.[1] : undefined;
  if (!ref || !BRANCH.test(ref) || ref.includes("..")) return null;
  return { branch: ref, deleted: b.deleted === true || (typeof b.after === "string" && /^0+$/.test(b.after)) };
}

export const previewsOf = async (liveId: string) => (await stagingOf(liveId)).filter((w) => w.environment === "preview");

/**
 * Reacts to a push. The app's own branch deploys it; any other branch gets (or
 * refreshes) a preview when previews are on, and loses it when it is deleted.
 * A push without branch information (a plain POST) deploys, as it always did.
 */
export async function handlePush(workloadId: string, push: { branch: string; deleted: boolean } | null): Promise<{ action: "deployed" | "preview" | "preview_removed" | "ignored"; id?: string }> {
  const live = await load(workloadId);
  if (live.type !== "app" && live.type !== "static") throw new PlatformError("This workload is not deployed from Git");
  if (live.environment !== "live") throw new PlatformError("Previews are built from the live app");
  if (!push || push.branch === (live.config.branch ?? "main")) return push?.deleted ? { action: "ignored" } : { action: "deployed", id: await deployWorkload(live.id, "push") };
  if (!live.config.previews) return { action: "ignored" };

  const previews = await previewsOf(live.id);
  const existing = previews.find((p) => p.config.branch === push.branch);
  if (push.deleted) {
    if (existing) await deleteWorkload(existing.id);
    return { action: existing ? "preview_removed" : "ignored" };
  }
  if (existing) return existing.status === "running" || existing.status === "error" ? { action: "preview", id: await deployWorkload(existing.id, "push") } : { action: "ignored" };
  if (live.status === "suspended") throw new PlatformError("This service is suspended");
  if (previews.length >= MAX_PREVIEWS) throw new PlatformError(`An app can have up to ${MAX_PREVIEWS} previews: delete a branch or a preview first`);

  // Same node, same settings and secrets as the app; only the branch differs. No deploy hook of its own.
  const db = await getDb();
  const [node] = await db.select().from(schema.nodes).where(eq(schema.nodes.id, live.nodeId));
  const slug = `pr-${slugify(push.branch).slice(0, 18).replace(/-+$/, "") || "branch"}-${randomBytes(3).toString("hex")}`;
  const previewId = await db.transaction(async (tx) => {
    const [w] = await tx
      .insert(schema.workloads)
      .values({ clientId: live.clientId, companyId: live.companyId, nodeId: live.nodeId, serviceId: live.serviceId, parentId: live.id, type: live.type, environment: "preview", name: `${live.name} (${push.branch.slice(0, 40)})`, slug, config: { ...live.config, branch: push.branch, previews: false, redirects: [] }, secrets: live.secrets, githubInstallationId: live.githubInstallationId, githubRepo: live.githubRepo })
      .returning({ id: schema.workloads.id });
    if (node.baseDomain) await tx.insert(schema.domains).values({ workloadId: w.id, hostname: `${slug}.${node.baseDomain}`, isPrimary: true, isSystem: true });
    return w.id;
  });
  const deploymentId = await newDeployment(previewId, "create");
  await enqueue({ id: previewId, nodeId: live.nodeId }, "workload.create", { spec: await specForBuild({ id: previewId, githubInstallationId: live.githubInstallationId, githubRepo: live.githubRepo }) }, { deploymentId });
  await audit(null, "preview.create", "workload", live.id, { branch: push.branch, previewId });
  return { action: "preview", id: previewId };
}

export async function setPreviews(workloadId: string, enabled: boolean, actorId: string | null = null) {
  const w = await load(workloadId);
  if ((w.type !== "app" && w.type !== "static") || w.environment !== "live") throw new PlatformError("Previews are available for apps and static sites");
  const db = await getDb();
  await db.update(schema.workloads).set({ config: { ...w.config, previews: enabled } }).where(eq(schema.workloads.id, w.id));
  // Switching previews off removes the ones that exist: nothing keeps running unseen.
  if (!enabled) for (const p of await previewsOf(w.id)) await deleteWorkload(p.id, actorId);
  await audit(actorId, enabled ? "preview.enabled" : "preview.disabled", "workload", w.id);
}

/** How many past images a node keeps per app, and therefore how far back a rollback can go. */
export const ROLLBACK_DEPTH = 5;

/** Successful deployments whose image is still on the node, newest first; the first one is what is live now. */
export async function rollbackCandidates(workloadId: string) {
  const db = await getDb();
  return db
    .select()
    .from(schema.deployments)
    .where(and(eq(schema.deployments.workloadId, workloadId), eq(schema.deployments.status, "live"), ne(schema.deployments.trigger, "rollback")))
    .orderBy(desc(schema.deployments.createdAt))
    .limit(ROLLBACK_DEPTH);
}

/** Puts a previous build back in service without rebuilding. */
export async function rollbackDeployment(workloadId: string, deploymentId: string, actorId: string | null = null) {
  const w = await load(workloadId);
  if (w.type !== "app") throw new PlatformError("Only applications can be rolled back; static sites are rebuilt from Git");
  if (w.status === "suspended") throw new PlatformError("This service is suspended");
  const target = (await rollbackCandidates(w.id)).find((d) => d.id === deploymentId);
  if (!target) throw new PlatformError("This deployment is too old to roll back to");
  const id = await newDeployment(w.id, "rollback", { rollbackOf: target.id, commitSha: target.commitSha, commitMessage: target.commitMessage });
  await enqueue(w, "workload.deploy", { spec: await buildSpec(w.id), deploymentId: id, rollbackTo: target.id }, { deploymentId: id, actorId });
  await audit(actorId, "workload.rollback", "workload", w.id, { to: target.commitSha.slice(0, 7) });
  return id;
}

export async function runTool(workloadId: string, tool: ToolName, args: Record<string, string> = {}, actorId: string | null = null) {
  const w = await load(workloadId);
  if (w.type !== "wordpress") throw new PlatformError("This tool is only available for WordPress");
  await audit(actorId, `tool.${tool}`, "workload", w.id);
  return enqueue(w, "workload.tool", { spec: await buildSpec(w.id), tool, args }, { actorId });
}

// ─── WordPress migration ─────────────────────────────────────────────────────


/**
 * Validates what the client typed. Everything that later reaches a shell on the
 * node is restricted to a safe alphabet here, and the node is never pointed at
 * loopback or private addresses.
 */
export function cleanMigrationSource(input: { type?: string; url?: string; host?: string; port?: string | number; user?: string; password?: string; path?: string }): { source: MigrationSource; label: string } {
  if (input.type === "archive") {
    let url: URL;
    try {
      url = new URL(String(input.url ?? "").trim());
    } catch {
      throw new PlatformError("Enter the full link to the archive, starting with https://");
    }
    if (url.protocol !== "https:" || url.username || url.password) throw new PlatformError("The archive link must start with https:// and contain no credentials");
    if (url.href.length > 2000) throw new PlatformError("This link is too long");
    if (!publicHttpsUrl(url.href)) throw new PlatformError("This address is not reachable from the internet");
    return { source: { type: "archive", url: url.href }, label: url.hostname };
  }
  if (input.type === "ssh") {
    const host = String(input.host ?? "").trim().toLowerCase();
    const user = String(input.user ?? "").trim();
    const path = String(input.path ?? "").trim().replace(/\/+$/, "") || ".";
    const port = Number(input.port || 22);
    const password = String(input.password ?? "");
    if (!/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z0-9-]{1,63}$/.test(host) || !publicHttpsUrl(`https://${host}/`)) throw new PlatformError("Enter the public host name or IP address of the old server");
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new PlatformError("Invalid port");
    if (!/^[a-z_][\w.-]{0,63}$/i.test(user)) throw new PlatformError("Invalid user name");
    if (!/^[\w.~/-]{1,300}$/.test(path) || path.includes("..")) throw new PlatformError("The folder may contain letters, numbers, dots, dashes and slashes only");
    if (!password || password.length > 200 || /[\r\n\0]/.test(password)) throw new PlatformError("Enter the SSH password");
    return { source: { type: "ssh", host, port, user, password, path }, label: `${user}@${host}` };
  }
  throw new PlatformError("Choose where to migrate from");
}

/** Copies another WordPress site over this one, after a safety backup. Returns the job id. */
export async function startMigration(workloadId: string, input: Parameters<typeof cleanMigrationSource>[0], actorId: string | null = null): Promise<string> {
  const w = await load(workloadId);
  if (w.type !== "wordpress") throw new PlatformError("Migrations are only available for WordPress");
  if (w.status !== "running") throw new PlatformError("The site must be running");
  const { source, label } = cleanMigrationSource(input);
  const db = await getDb();
  const [busy] = await db.select({ id: schema.jobs.id }).from(schema.jobs).where(and(eq(schema.jobs.workloadId, w.id), eq(schema.jobs.type, "workload.migrate"), inArray(schema.jobs.status, ["queued", "running"])));
  if (busy) throw new PlatformError("A migration is already in progress");
  const spec = await buildSpec(w.id);
  // Jobs of one workload run in order: the safety backup finishes before the import starts.
  await createBackup(w.id, "Before migration", "system", actorId);
  const jobId = await enqueue(w, "workload.migrate", { spec, source, newUrl: `https://${spec.domains[0]}`, label }, { actorId });
  await audit(actorId, "workload.migrate", "workload", w.id, { from: label, type: source.type });
  return jobId;
}

export type MigrationRun = { id: string; status: string; label: string; createdAt: Date; finishedAt: Date | null; error: string; log: string; summary: { oldUrl?: string; tablePrefix?: string; wpVersion?: string } };

export async function listMigrations(workloadId: string): Promise<MigrationRun[]> {
  const db = await getDb();
  const jobs = await db.select().from(schema.jobs).where(and(eq(schema.jobs.workloadId, workloadId), eq(schema.jobs.type, "workload.migrate"))).orderBy(desc(schema.jobs.createdAt)).limit(10);
  return jobs.map((j) => {
    let summary = {};
    try {
      summary = JSON.parse(String(j.result?.output ?? "{}"));
    } catch {}
    return { id: j.id, status: j.status, label: String(decryptJson<{ label?: string }>(j.payload, {}).label ?? ""), createdAt: j.createdAt, finishedAt: j.finishedAt, error: j.error, log: j.log, summary };
  });
}

/** The newest finished integrity scan of a site. */
export async function latestScan(workloadId: string): Promise<{ at: Date; scan: WpScan; findings: number } | null> {
  const db = await getDb();
  const jobs = await db.select().from(schema.jobs).where(and(eq(schema.jobs.workloadId, workloadId), eq(schema.jobs.type, "workload.tool"), eq(schema.jobs.status, "succeeded"))).orderBy(desc(schema.jobs.createdAt)).limit(40);
  for (const j of jobs) {
    const out = String(j.result.output ?? "");
    if (!out.startsWith('{"scan"')) continue;
    try {
      const { scan } = JSON.parse(out) as { scan: WpScan };
      return { at: j.finishedAt ?? j.createdAt, scan, findings: scan.core.length + scan.plugins.length + scan.uploadsPhp.length + scan.suspicious.length };
    } catch {}
  }
  return null;
}

/** Cron: every live WordPress site is scanned once a week, a few per run so nodes are not flooded. */
export async function runWpScans(now = new Date(), limit = 10): Promise<number> {
  const db = await getDb();
  const sites = await db.select().from(schema.workloads).where(and(eq(schema.workloads.type, "wordpress"), eq(schema.workloads.environment, "live"), eq(schema.workloads.status, "running")));
  let started = 0;
  for (const w of sites) {
    if (started >= limit) break;
    if (w.config.scanLastAt && now.getTime() - new Date(w.config.scanLastAt).getTime() < 7 * 24 * 60 * MINUTE) continue;
    const node = await db.query.nodes.findFirst({ where: eq(schema.nodes.id, w.nodeId) });
    if (!node || !nodeIsOnline(node)) continue;
    await db.update(schema.workloads).set({ config: { ...w.config, scanLastAt: now.toISOString() } }).where(eq(schema.workloads.id, w.id));
    await enqueue(w, "workload.tool", { spec: await buildSpec(w.id), tool: "wp.scan", args: {} });
    started++;
  }
  return started;
}

export const PHP_LIMITS = { memoryLimitMb: [64, 1024], uploadMaxMb: [2, 1024], maxExecutionTime: [30, 600], maxInputVars: [1000, 20000] } as const;

/** PHP limits and the Redis object cache of a WordPress site. Values outside the allowed ranges are pulled back in. */
export async function savePhpSettings(workloadId: string, input: { memoryLimitMb: number; uploadMaxMb: number; maxExecutionTime: number; maxInputVars: number; objectCache: boolean }, actorId: string | null = null) {
  const w = await load(workloadId);
  if (w.type !== "wordpress") throw new PlatformError("PHP settings are available for WordPress sites");
  const clamp = (key: keyof typeof PHP_LIMITS) => Math.min(PHP_LIMITS[key][1], Math.max(PHP_LIMITS[key][0], Math.round(Number(input[key]) || PHP_LIMITS[key][0])));
  const php = { memoryLimitMb: clamp("memoryLimitMb"), uploadMaxMb: clamp("uploadMaxMb"), maxExecutionTime: clamp("maxExecutionTime"), maxInputVars: clamp("maxInputVars") };
  // PHP cannot be promised more memory than the container has.
  php.memoryLimitMb = Math.min(php.memoryLimitMb, Math.max(64, Math.floor((w.config.memoryMb ?? 512) / 2)));
  await updateWorkloadConfig(w.id, { php, objectCache: input.objectCache }, actorId);
}

/** `registry/name:tag` of a public image. Digests and tags allowed; no credentials, no flags. */
export function cleanImage(input: string): string {
  const image = input.trim();
  if (!/^(?=.{3,200}$)[a-z0-9]([a-z0-9._-]*[a-z0-9])?(:\d{2,5})?(\/[a-z0-9]([a-z0-9._-]*[a-z0-9])?)*(:[\w][\w.-]{0,127})?(@sha256:[0-9a-f]{64})?$/.test(image)) throw new PlatformError("Enter an image such as ghcr.io/acme/api:1.4.2");
  return image;
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,99}$/;

async function groupEnv(companyId: string | null, ids: string[] | undefined): Promise<Record<string, string>> {
  if (!companyId || !ids?.length) return {};
  const db = await getDb();
  const groups = await db.select().from(schema.envGroups).where(and(eq(schema.envGroups.companyId, companyId), inArray(schema.envGroups.id, ids)));
  // In the order they were attached, so a later group overrides an earlier one predictably.
  return Object.assign({}, ...ids.map((id) => decryptJson<Record<string, string>>(groups.find((g) => g.id === id)?.vars ?? "", {})));
}

/** Creates or replaces a shared group, then re-applies every service that uses it. */
export async function saveEnvGroup(companyId: string, input: { id?: string; name: string; vars: Record<string, string> }, actorId: string | null = null): Promise<string> {
  const name = input.name.trim().slice(0, 60);
  if (!name) throw new PlatformError("Give the group a name");
  const entries = Object.entries(input.vars);
  if (entries.length > 100 || entries.some(([k, v]) => !ENV_NAME.test(k) || v.length > 10_000)) throw new PlatformError("Invalid variable name, or too many variables");
  const db = await getDb();
  const values = { companyId, name, vars: encryptJson(input.vars) };
  let id = input.id;
  if (id) {
    const [row] = await db.update(schema.envGroups).set(values).where(and(eq(schema.envGroups.id, id), eq(schema.envGroups.companyId, companyId))).returning({ id: schema.envGroups.id });
    if (!row) throw new PlatformError("Group not found");
  } else {
    const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.envGroups).where(eq(schema.envGroups.companyId, companyId));
    if (n >= 20) throw new PlatformError("A company can have up to 20 variable groups");
    [{ id }] = await db.insert(schema.envGroups).values(values).returning({ id: schema.envGroups.id });
  }
  await audit(actorId, "envgroup.saved", "company", companyId, { name, keys: Object.keys(input.vars) });
  for (const w of await usersOfGroup(companyId, id!)) await applyWorkload(w.id, actorId).catch(() => {});
  return id!;
}

const usersOfGroup = async (companyId: string, groupId: string) => (await (await getDb()).select().from(schema.workloads).where(and(eq(schema.workloads.companyId, companyId), ne(schema.workloads.status, "deleted")))).filter((w) => w.config.envGroupIds?.includes(groupId));

export async function deleteEnvGroup(companyId: string, groupId: string, actorId: string | null = null) {
  if ((await usersOfGroup(companyId, groupId)).length) throw new PlatformError("Detach the group from its services first");
  await (await getDb()).delete(schema.envGroups).where(and(eq(schema.envGroups.id, groupId), eq(schema.envGroups.companyId, companyId)));
  await audit(actorId, "envgroup.deleted", "company", companyId);
}

/** Which of the company's groups a service uses. Groups of other companies are silently dropped. */
export async function attachEnvGroups(workloadId: string, groupIds: string[], actorId: string | null = null) {
  const w = await load(workloadId);
  if (w.type !== "app" && w.type !== "static") throw new PlatformError("Variable groups are available for applications and static sites");
  const db = await getDb();
  const mine = w.companyId ? await db.select({ id: schema.envGroups.id }).from(schema.envGroups).where(eq(schema.envGroups.companyId, w.companyId)) : [];
  const envGroupIds = [...new Set(groupIds)].filter((id) => mine.some((g) => g.id === id)).slice(0, 10);
  await updateWorkloadConfig(w.id, { envGroupIds }, actorId);
}

/** Replaces the scheduled jobs of an app. `text` is one job per line, see `parseCronLines`. */
export async function saveCrons(workloadId: string, text: string, actorId: string | null = null) {
  const w = await load(workloadId);
  if (w.type !== "app" || w.environment !== "live") throw new PlatformError("Scheduled jobs are available for applications");
  let crons: CronJob[];
  try {
    crons = parseCronLines(text);
  } catch (err) {
    throw new PlatformError(err instanceof Error ? err.message : "Invalid schedule");
  }
  await updateWorkloadConfig(w.id, { crons }, actorId);
}

// ─── WordPress: one-click login and automatic updates ───────────────────────

/** Queues a single-use wp-admin link; the page that asked for it shows it once and wipes it. */
export async function requestWpLogin(workloadId: string, actorId: string | null = null): Promise<string> {
  const w = await load(workloadId);
  if (w.type !== "wordpress") throw new PlatformError("This tool is only available for WordPress");
  if (w.status !== "running") throw new PlatformError("The site must be running");
  await audit(actorId, "wp.login_link", "workload", w.id);
  return enqueue(w, "workload.tool", { spec: await buildSpec(w.id), tool: "wp.login", args: {} }, { actorId });
}

/** Reads the link of a finished login job exactly once: the stored copy is erased while it is handed out. */
export async function takeWpLoginUrl(workloadId: string, jobId: string): Promise<{ state: "waiting" | "failed" | "gone" } | { state: "ready"; url: string }> {
  const db = await getDb();
  const [job] = await db.select().from(schema.jobs).where(and(eq(schema.jobs.id, jobId), eq(schema.jobs.workloadId, workloadId), eq(schema.jobs.type, "workload.tool")));
  if (!job) return { state: "gone" };
  if (job.status === "queued" || job.status === "running") return { state: "waiting" };
  if (job.status !== "succeeded") return { state: "failed" };
  const [taken] = await db.update(schema.jobs).set({ result: {} }).where(and(eq(schema.jobs.id, job.id), sql`${schema.jobs.result}->>'output' is not null`)).returning({ id: schema.jobs.id });
  try {
    const url = (JSON.parse(String(job.result.output ?? "{}")) as { url?: string }).url;
    return taken && url && /^https:\/\/[^\s]+\?aster_login=[0-9a-f]{64}$/.test(url) ? { state: "ready", url } : { state: "gone" };
  } catch {
    return { state: "gone" };
  }
}

export async function setAutoUpdate(workloadId: string, mode: "off" | "minor" | "all", actorId: string | null = null) {
  const w = await load(workloadId);
  if (w.type !== "wordpress" || w.environment !== "live") throw new PlatformError("Automatic updates are available for live WordPress sites");
  await (await getDb()).update(schema.workloads).set({ config: { ...w.config, autoUpdate: mode } }).where(eq(schema.workloads.id, w.id));
  await audit(actorId, "wp.autoupdate_mode", "workload", w.id, { mode });
}

/**
 * Cron: once a day per site, a backup and then the updates. The node checks
 * the home page before and after; if the update broke it, the job fails and
 * `applyOutcome` puts the backup back.
 */
export async function runWpAutoUpdates(now = new Date()): Promise<number> {
  const db = await getDb();
  const sites = await db.select().from(schema.workloads).where(and(eq(schema.workloads.type, "wordpress"), eq(schema.workloads.environment, "live"), eq(schema.workloads.status, "running")));
  let started = 0;
  for (const w of sites) {
    const mode = w.config.autoUpdate ?? "off";
    if (mode === "off" || (w.config.autoUpdateLastAt && now.getTime() - new Date(w.config.autoUpdateLastAt).getTime() < 24 * 60 * MINUTE)) continue;
    const node = await db.query.nodes.findFirst({ where: eq(schema.nodes.id, w.nodeId) });
    if (!node || !nodeIsOnline(node)) continue;
    await db.update(schema.workloads).set({ config: { ...w.config, autoUpdateLastAt: now.toISOString() } }).where(eq(schema.workloads.id, w.id));
    const backupId = await createBackup(w.id, "Before automatic update", "system");
    await enqueue(w, "workload.tool", { spec: await buildSpec(w.id), tool: "wp.autoupdate", args: { scope: mode, backupId } });
    await enqueue(w, "workload.tool", { spec: await buildSpec(w.id), tool: "wp.inventory", args: {} });
    started++;
  }
  return started;
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

/**
 * HSTS, a password in front of the whole site (handy for staging and sites under
 * construction), and server-side WP-Cron. An empty user removes the password;
 * an empty password keeps the current one.
 */
export async function saveEdgeSecurity(workloadId: string, input: { hsts: boolean; user: string; password: string; systemCron: boolean }, actorId: string | null = null) {
  const w = await load(workloadId);
  if (w.type === "database") throw new PlatformError("These settings apply to web services");
  const user = input.user.trim();
  if (user && !/^[\w.@-]{1,40}$/.test(user)) throw new PlatformError("The user name may contain letters, numbers, dots, dashes and @");
  const secrets = readSecrets(w);
  if (user) {
    if (input.password && (input.password.length < 8 || input.password.length > 100)) throw new PlatformError("The password must be between 8 and 100 characters");
    if (input.password) secrets.sitePassword = input.password;
    if (!secrets.sitePassword) throw new PlatformError("Enter a password");
  } else delete secrets.sitePassword;
  const db = await getDb();
  await db.update(schema.workloads).set({ config: { ...w.config, hsts: input.hsts, sitePasswordUser: user || undefined, systemCron: w.type === "wordpress" ? input.systemCron : undefined }, secrets: encryptJson(secrets) }).where(eq(schema.workloads.id, w.id));
  await applyWorkload(w.id, actorId);
  await audit(actorId, "edge.security", "workload", w.id, { hsts: input.hsts, password: !!user, systemCron: input.systemCron });
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

const SNAPSHOTS_KEPT = 20;

/** Remembers the zone as it is now. Call before changing it. */
export async function snapshotZone(zoneId: string, reason: string, actorId: string | null = null) {
  const db = await getDb();
  const records = await db.select().from(schema.dnsRecords).where(eq(schema.dnsRecords.zoneId, zoneId));
  await db.insert(schema.dnsSnapshots).values({ zoneId, reason: reason.slice(0, 120), actorId, records: records.map(({ name, type, value, ttl, priority }) => ({ name, type, value, ttl, priority })) });
  const old = await db.select({ id: schema.dnsSnapshots.id }).from(schema.dnsSnapshots).where(eq(schema.dnsSnapshots.zoneId, zoneId)).orderBy(desc(schema.dnsSnapshots.createdAt)).offset(SNAPSHOTS_KEPT);
  if (old.length) await db.delete(schema.dnsSnapshots).where(inArray(schema.dnsSnapshots.id, old.map((o) => o.id)));
}

/**
 * Adds many records at once (a template, an imported zone file). Each one goes
 * through the same validation as a record typed by hand; duplicates and records
 * that would clash with a CNAME are left out and reported.
 */
export async function addDnsRecords(zoneId: string, input: { name: string; type: string; value: string; ttl: number; priority: number }[], reason: string, actorId: string | null = null): Promise<{ added: number; skipped: string[] }> {
  const db = await getDb();
  const existing = await db.select().from(schema.dnsRecords).where(eq(schema.dnsRecords.zoneId, zoneId));
  const have = existing.map(({ name, type, value }) => ({ name, type, value }));
  const accepted: ReturnType<typeof cleanDnsRecord>[] = [];
  const skipped: string[] = [];
  for (const raw of input.slice(0, 500)) {
    const label = `${raw.name} ${raw.type} ${raw.value}`.slice(0, 100);
    try {
      const r = cleanDnsRecord(raw);
      const sameName = have.filter((h) => h.name === r.name);
      if (sameName.some((h) => h.type === r.type && h.value === r.value)) skipped.push(`${label} — already there`);
      else if (sameName.some((h) => (h.type === "CNAME") !== (r.type === "CNAME")) || (r.type === "CNAME" && sameName.length)) skipped.push(`${label} — clashes with a CNAME of the same name`);
      else {
        accepted.push(r);
        have.push(r);
      }
    } catch (err) {
      skipped.push(`${label} — ${err instanceof Error ? err.message : "invalid"}`);
    }
  }
  if (accepted.length) {
    await snapshotZone(zoneId, reason, actorId);
    await db.insert(schema.dnsRecords).values(accepted.map((r) => ({ zoneId, ...r })));
    await audit(actorId, "dns.records_added", "dns_zone", zoneId, { reason, count: accepted.length });
    await touchZone(zoneId);
  }
  return { added: accepted.length, skipped };
}

/** Puts the zone back to a snapshot (the current state is snapshotted first, so this too can be undone). */
export async function restoreZoneSnapshot(zoneId: string, snapshotId: string, actorId: string | null = null) {
  const db = await getDb();
  const [snap] = await db.select().from(schema.dnsSnapshots).where(and(eq(schema.dnsSnapshots.id, snapshotId), eq(schema.dnsSnapshots.zoneId, zoneId)));
  if (!snap) throw new PlatformError("Snapshot not found");
  await snapshotZone(zoneId, "Before restoring an earlier version", actorId);
  await db.transaction(async (tx) => {
    await tx.delete(schema.dnsRecords).where(eq(schema.dnsRecords.zoneId, zoneId));
    if (snap.records.length) await tx.insert(schema.dnsRecords).values(snap.records.map((r) => ({ zoneId, ...r, type: r.type as schema.DnsType })));
  });
  await audit(actorId, "dns.restored", "dns_zone", zoneId, { snapshot: snap.id });
  await touchZone(zoneId);
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

// ─── Managed database administration ────────────────────────────────────────

export const DB_VERSIONS = { mysql: ["10.11", "11"], postgres: ["15", "16", "17"], redis: ["7"] } as const;

async function sqlDatabase(workloadId: string) {
  const w = await load(workloadId);
  if (w.type !== "database") throw new PlatformError("Available for managed databases");
  if (w.status !== "running") throw new PlatformError("The database must be running");
  return w;
}

/**
 * New password for the database user. The node changes it first; only when
 * that worked does the panel start showing (and using) the new one. Apps keep
 * the old password in their own environment variables: they must be updated.
 */
export async function rotateDbPassword(workloadId: string, actorId: string | null = null): Promise<string> {
  const w = await sqlDatabase(workloadId);
  await audit(actorId, "db.password_rotated", "workload", w.id);
  if (w.config.engine === "redis") {
    // Redis reads its password at start: a new secret and a restart are the whole rotation.
    await (await getDb()).update(schema.workloads).set({ secrets: encryptJson({ ...readSecrets(w), dbPassword: password() }) }).where(eq(schema.workloads.id, w.id));
    await applyWorkload(w.id, actorId);
    return "";
  }
  return enqueue(w, "workload.dbadmin", { spec: await buildSpec(w.id), action: "rotate", newPassword: password() }, { actorId });
}

/** Loads a SQL dump from an https link into the database, after a safety backup. */
export async function importDbDump(workloadId: string, link: string, actorId: string | null = null): Promise<string> {
  const w = await sqlDatabase(workloadId);
  if (w.config.engine === "redis") throw new PlatformError("Dumps can be imported into MySQL and PostgreSQL databases");
  const url = publicHttpsUrl(link);
  if (!url) throw new PlatformError("Enter a public https:// link to the dump (.sql or .sql.gz)");
  await createBackup(w.id, "Before import", "system", actorId);
  await audit(actorId, "db.import", "workload", w.id, { from: url.hostname });
  return enqueue(w, "workload.dbadmin", { spec: await buildSpec(w.id), action: "import", url: url.href }, { actorId });
}

/** Moves the data to a newer engine version (dump, new volume, restore), after a safety backup. Downgrades are refused. */
export async function upgradeDbVersion(workloadId: string, version: string, actorId: string | null = null): Promise<string> {
  const w = await sqlDatabase(workloadId);
  const engineName = w.config.engine ?? "mysql";
  if (engineName === "redis") throw new PlatformError("Redis has a single supported version");
  const versions: readonly string[] = DB_VERSIONS[engineName];
  const current = w.config.version || versions.at(-1)!;
  if (!versions.includes(version) || versions.indexOf(version) <= versions.indexOf(current)) throw new PlatformError("Choose a newer version than the current one");
  await createBackup(w.id, `Before upgrade to ${version}`, "system", actorId);
  await (await getDb()).update(schema.workloads).set({ config: { ...w.config, version } }).where(eq(schema.workloads.id, w.id));
  await audit(actorId, "db.upgrade", "workload", w.id, { from: current, to: version });
  return enqueue(w, "workload.dbadmin", { spec: await buildSpec(w.id), action: "upgrade" }, { actorId });
}

// ─── Scheduled backups ───────────────────────────────────────────────────────

const BACKUP_EVERY_MS = 24 * 60 * MINUTE;

/** Daily backup of every running site/database, keeping the most recent ones. Idempotent. */
export async function runScheduledBackups(now = new Date()): Promise<{ created: number; pruned: number }> {
  const db = await getDb();
  const targets = await db
    .select({ id: schema.workloads.id })
    .from(schema.workloads)
    .where(and(eq(schema.workloads.status, "running"), eq(schema.workloads.environment, "live"), inArray(schema.workloads.type, ["wordpress", "database"])));
  const keep = (await getSettings("backups")).keepScheduled;
  let created = 0;
  let pruned = 0;
  for (const { id } of targets) {
    const scheduled = await db.select().from(schema.backups).where(and(eq(schema.backups.workloadId, id), eq(schema.backups.kind, "scheduled"))).orderBy(desc(schema.backups.createdAt));
    if (!scheduled[0] || now.getTime() - scheduled[0].createdAt.getTime() >= BACKUP_EVERY_MS) {
      await createBackup(id, "", "scheduled");
      created++;
    }
    for (const old of scheduled.filter((b) => b.status === "ready").slice(keep - 1)) {
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
  // Finished jobs do not keep what they no longer need: file contents, storage keys.
  const scrubbed =
    job.type === "workload.files"
      ? encryptJson({ ...decryptJson<Record<string, unknown>>(job.payload, {}), content: undefined, spec: undefined })
      : job.type === "workload.dbadmin"
        ? encryptJson({ action: decryptJson<{ action?: string }>(job.payload, {}).action })
      : job.type === "workload.migrate"
        ? encryptJson({ label: decryptJson<{ label?: string }>(job.payload, {}).label })
      : job.type.startsWith("backup.") || job.type === "offsite.test"
        ? encryptJson({ ...decryptJson<Record<string, unknown>>(job.payload, {}), offsite: undefined })
        : job.payload;
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
      // A rollback already knows its commit; a build reports it.
      .set({ status: ok ? "live" : "failed", ...(result.commitSha ? { commitSha: result.commitSha, commitMessage: (result.commitMessage ?? "").slice(0, 300) } : {}), finishedAt: new Date() })
      .where(eq(deployments.id, job.deploymentId));
  }
  if (job.backupId) {
    if (job.type === "backup.delete" && ok) await db.delete(backups).where(eq(backups.id, job.backupId));
    else if (job.type === "backup.create")
      await db
        .update(backups)
        .set({ status: ok ? "ready" : "failed", sizeBytes: Math.round(result.sizeBytes ?? 0), offsite: ok ? (result.offsite ?? "none") : "none", offsiteError: (result.offsiteError ?? "").slice(0, 500) })
        .where(eq(backups.id, job.backupId));
    else await db.update(backups).set({ status: "ready" }).where(eq(backups.id, job.backupId));
  }
  if (!w) return;

  if (job.type === "workload.dbadmin" && ok) {
    const { action, newPassword } = decryptJson<{ action?: string; newPassword?: string }>(job.payload, {});
    if (action === "rotate" && newPassword) await db.update(workloads).set({ secrets: encryptJson({ ...readSecrets(w), dbPassword: newPassword }) }).where(eq(workloads.id, w.id));
  }
  if (job.type === "workload.tool" && ok && String(result.output ?? "").startsWith('{"scan"')) {
    try {
      const { scan } = JSON.parse(String(result.output)) as { scan: WpScan };
      const scanFindings = scan.core.length + scan.plugins.length + scan.uploadsPhp.length + scan.suspicious.length;
      await db.update(workloads).set({ config: { ...w.config, scanFindings } }).where(eq(workloads.id, w.id));
      if (scanFindings > 0) await audit(null, "wp.scan_findings", "workload", w.id, { findings: scanFindings });
    } catch {}
  }
  if (job.type === "workload.tool" && !ok && /^SITE_UNHEALTHY/.test(error)) {
    // An automatic update broke the site: put back the backup taken right before it.
    const { tool, args } = decryptJson<{ tool?: string; args?: { backupId?: string } }>(job.payload, {});
    if (tool === "wp.autoupdate" && args?.backupId) {
      await restoreBackup(w.id, args.backupId).catch(() => {});
      await audit(null, "wp.autoupdate_rolled_back", "workload", w.id, { reason: error.slice(0, 200) });
    }
  }
  const site = { id: w.id, name: w.name, type: w.type };
  if (job.deploymentId && result.commitSha && w.githubInstallationId) {
    const { reportCommitStatus } = await import("@/lib/github");
    const origin = (process.env.APP_URL || (await getSettings("general")).siteUrl || "").replace(/\/+$/, "");
    await reportCommitStatus(w, result.commitSha, ok ? "success" : "failure", ok ? `Live on ${w.name}` : error || "Deploy failed", `${origin}/client/workloads/${w.id}/deployments`);
  }
  if (job.type === "workload.deploy") emitEvent(w.companyId, ok ? "deploy.succeeded" : "deploy.failed", { site, deploymentId: job.deploymentId, commit: result.commitSha ?? "", error });
  else if (job.type === "backup.create") emitEvent(w.companyId, ok ? "backup.completed" : "backup.failed", { site, backupId: job.backupId, sizeBytes: result.sizeBytes ?? 0, error });
  else if (job.type === "workload.migrate") emitEvent(w.companyId, ok ? "migration.succeeded" : "migration.failed", { site, error });

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
    case "workload.migrate":
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
