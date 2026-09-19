import "server-only";
import { and, eq, ne, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { CloudError, getCloudProvider, SERVER_NAME, SLUG, type CloudCredentials, type CloudProvider, type Http } from "@/modules/cloud";
import { signingKeys } from "@/platform/engine";
import { audit } from "./audit";
import { randomToken, sha256 } from "./crypto";
import { publicHttpsUrl } from "./net";
import { getSettings } from "./settings";

/** Nodes on cloud providers: the panel creates the machine, the machine installs the agent by itself. */

let http: Http = (...args) => fetch(...args);
export const setCloudHttpForTests = (fake: Http) => void (http = fake);
/** The HTTP layer in use (the real one, or the tests' fake), for modules that talk to providers next to this one. */
export const cloudHttp = (): Http => http;

export class CloudNodeError extends Error {}

export async function cloudAccount(providerId: string): Promise<{ provider: CloudProvider; creds: CloudCredentials }> {
  const provider = getCloudProvider(providerId);
  const creds = (await getSettings("cloud")).accounts[providerId];
  if (!provider || !creds || creds.enabled !== "1") throw new CloudNodeError("This cloud provider is not enabled");
  return { provider, creds };
}

export async function enabledCloudProviders(): Promise<CloudProvider[]> {
  const { accounts } = await getSettings("cloud");
  return Object.entries(accounts).filter(([, a]) => a.enabled === "1").map(([id]) => getCloudProvider(id)).filter((p): p is CloudProvider => !!p);
}

export async function testCloudProvider(providerId: string): Promise<string> {
  const { provider, creds } = await cloudAccount(providerId);
  return provider.test(creds, http);
}

/**
 * First-boot script for Ubuntu 24.04: Docker, git, Node.js, then the normal
 * node installer. Every interpolated value is validated by the caller; the
 * guard at the top makes it safe where the script runs on every boot (GCP).
 */
export function bootScript(input: { origin: string; token: string; publicKey: string; acmeEmail: string }): string {
  if (!publicHttpsUrl(input.origin)) throw new CloudNodeError("Set a public https:// Site URL in Settings first: new servers download the agent from it");
  if (!/^[\w.-]+$/.test(input.token) || !/^[A-Za-z0-9+/=]+$/.test(input.publicKey) || !/^[^\s'"\\]*$/.test(input.acmeEmail)) throw new CloudNodeError("Invalid value for the boot script");
  return `#!/bin/bash
[ -f /etc/aster-agent.env ] && exit 0
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y ca-certificates curl git
curl -fsSL https://get.docker.com | sh
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs
curl -fsSL '${input.origin}/agent/install.sh' | ASTER_URL='${input.origin}' ASTER_TOKEN='${input.token}' ASTER_PUBLIC_KEY='${input.publicKey}' ASTER_ACME_EMAIL='${input.acmeEmail}' bash
`;
}

export async function createCloudNode(input: { provider: string; name: string; region: string; size: string; baseDomain: string; maxWorkloads: number; origin: string; autoscaled?: boolean }, actorId: string | null = null): Promise<string> {
  const { provider, creds } = await cloudAccount(input.provider);
  const name = input.name.trim().toLowerCase();
  if (!SERVER_NAME.test(name)) throw new CloudNodeError("Use lower-case letters, numbers and dashes for the server name, starting with a letter");
  if (!SLUG.test(input.region) || !SLUG.test(input.size)) throw new CloudNodeError("Choose a region and a size");
  const db = await getDb();
  const [clash] = await db.select({ id: schema.nodes.id }).from(schema.nodes).where(eq(schema.nodes.name, name));
  if (clash) throw new CloudNodeError("A server with this name already exists");

  const token = randomToken(32);
  const [node] = await db.insert(schema.nodes).values({ name, region: input.region, baseDomain: input.baseDomain, maxWorkloads: input.maxWorkloads, tokenHash: sha256(token), provider: provider.id, providerRegion: input.region, providerSize: input.size, autoscaled: !!input.autoscaled }).returning({ id: schema.nodes.id });
  try {
    const script = bootScript({ origin: input.origin, token: `${node.id}.${token}`, publicKey: (await signingKeys()).publicKey, acmeEmail: (await getSettings("cloud")).acmeEmail });
    // An address from the administrator's pools, when one covers this provider and region.
    const { leaseAddress } = await import("./ip-pools");
    const ip = (await leaseAddress(provider.id, input.region, node.id)) ?? undefined;
    const server = await provider.create(creds, { name, region: input.region, size: input.size, bootScript: script, ip }, http);
    await db.update(schema.nodes).set({ providerServerId: server.id, publicIp: ip?.address ?? server.ip }).where(eq(schema.nodes.id, node.id));
    if (ip) await publishNodeDns({ name, baseDomain: input.baseDomain, publicIp: ip.address }).catch(() => {});
  } catch (err) {
    // Nothing was created (or we cannot know what): do not leave a node that will never come online.
    // Its address goes back to the pool, still reserved, ready for the next server.
    await (await import("./ip-pools")).unlease(node.id).catch(() => {});
    await db.delete(schema.nodes).where(eq(schema.nodes.id, node.id));
    throw err instanceof CloudError || err instanceof CloudNodeError ? new CloudNodeError(err.message) : err;
  }
  await audit(actorId, "node.cloud_created", "node", node.id, { provider: provider.id, region: input.region, size: input.size });
  return node.id;
}

/** Cron / page load: fills in the public address of machines that did not have one yet. */
export async function syncCloudNodes(): Promise<number> {
  const db = await getDb();
  const waiting = await db.select().from(schema.nodes).where(and(ne(schema.nodes.provider, ""), ne(schema.nodes.providerServerId, ""), eq(schema.nodes.publicIp, "")));
  let updated = 0;
  for (const n of waiting) {
    try {
      const { provider, creds } = await cloudAccount(n.provider);
      const server = await provider.get(creds, n.providerServerId, n.providerRegion, http);
      if (server.ip) {
        await db.update(schema.nodes).set({ publicIp: server.ip }).where(eq(schema.nodes.id, n.id));
        await publishNodeDns({ ...n, publicIp: server.ip }).catch(() => {});
        updated++;
      }
    } catch {
      // Provider unreachable or switched off: try again next time.
    }
  }
  return updated;
}

/** Destroys the machine at the provider. The caller removes the node row afterwards. */
export async function destroyCloudServer(nodeId: string, actorId: string | null = null): Promise<void> {
  const db = await getDb();
  const [n] = await db.select().from(schema.nodes).where(eq(schema.nodes.id, nodeId));
  if (!n?.provider || !n.providerServerId) return;
  const { provider, creds } = await cloudAccount(n.provider).catch((err: Error) => {
    throw new CloudNodeError(`${err.message}. Enable it again, or delete the machine from the provider's console.`);
  });
  try {
    await provider.destroy(creds, n.providerServerId, n.providerRegion, http);
  } catch (err) {
    throw new CloudNodeError(err instanceof CloudError ? err.message : "The cloud provider could not be reached");
  }
  await db.update(schema.nodes).set({ providerServerId: "" }).where(eq(schema.nodes.id, n.id));
  await audit(actorId, "node.cloud_destroyed", "node", n.id, { provider: n.provider });
}

// ─── Automatic capacity ──────────────────────────────────────────────────────

/**
 * When the node's base domain lives in a DNS zone hosted by this panel, its
 * wildcard record is created here, so new sites resolve without anyone touching DNS.
 */
export async function publishNodeDns(node: { name: string; baseDomain: string; publicIp: string }): Promise<boolean> {
  if (!node.baseDomain || !/^\d{1,3}(\.\d{1,3}){3}$/.test(node.publicIp)) return false;
  const db = await getDb();
  const zones = await db.select().from(schema.dnsZones);
  const zone = zones.filter((z) => node.baseDomain === z.name || node.baseDomain.endsWith(`.${z.name}`)).sort((a, b) => b.name.length - a.name.length)[0];
  if (!zone) return false;
  const rel = node.baseDomain === zone.name ? "" : node.baseDomain.slice(0, -zone.name.length - 1);
  const existing = await db.select().from(schema.dnsRecords).where(eq(schema.dnsRecords.zoneId, zone.id));
  const wanted = [rel || "@", rel ? `*.${rel}` : "*"].filter((name) => !existing.some((r) => r.name === name && r.type === "A"));
  if (!wanted.length) return false;
  await db.insert(schema.dnsRecords).values(wanted.map((name) => ({ zoneId: zone.id, name, type: "A" as const, value: node.publicIp, ttl: 300 })));
  const { touchZone } = await import("@/platform/engine");
  await touchZone(zone.id);
  return true;
}

const PENDING_FOR_MS = 45 * 60_000;
let creating: Promise<unknown> = Promise.resolve();

/** Room on servers that are up, or were created recently and are still installing. */
async function capacity() {
  const db = await getDb();
  const { nodeIsOnline } = await import("@/platform/engine");
  const rows = await db.select({ node: schema.nodes, used: sql<number>`count(${schema.workloads.id})::int` }).from(schema.nodes).leftJoin(schema.workloads, and(eq(schema.workloads.nodeId, schema.nodes.id), ne(schema.workloads.status, "deleted"))).where(ne(schema.nodes.status, "disabled")).groupBy(schema.nodes.id);
  const usable = rows.filter(({ node }) => nodeIsOnline(node) || (node.autoscaled && !node.lastSeenAt && Date.now() - node.createdAt.getTime() < PENDING_FOR_MS));
  return { rows, usable, free: usable.reduce((sum, { node, used }) => sum + (node.maxWorkloads === 0 ? 1_000 : Math.max(0, node.maxWorkloads - used)), 0) };
}

/**
 * A server with room in automatic mode: one that is still starting up, or a
 * brand-new one. Null when automatic mode is off, the limit is reached, or
 * another region was asked for. Creations are serialised: two orders arriving
 * together share one new server instead of starting two.
 */
export function autoscaleNode(region?: string, origin?: string, forceNew = false): Promise<typeof schema.nodes.$inferSelect | null> {
  const run = async () => {
    const { autoscale } = await getSettings("cloud");
    if (!autoscale.enabled || !autoscale.provider || (region && region !== autoscale.region)) return null;
    const db = await getDb();
    const { rows, usable } = await capacity();
    const starting = usable.find(({ node, used }) => node.autoscaled && !node.lastSeenAt && node.providerRegion === autoscale.region && used < node.maxWorkloads);
    if (starting && !forceNew) return starting.node;
    if (rows.filter(({ node }) => node.autoscaled).length >= autoscale.maxNodes) return null;
    const name = `auto-${autoscale.region.replace(/[^a-z0-9]/g, "").slice(0, 12)}-${randomToken(4).toLowerCase().replace(/[^a-z0-9]/g, "x")}`;
    const { baseUrl } = await import("./url");
    const id = await createCloudNode({ provider: autoscale.provider, name, region: autoscale.region, size: autoscale.size, baseDomain: autoscale.baseDomainTemplate.replace("{name}", name), maxWorkloads: autoscale.workloadsPerNode, origin: origin ?? (await baseUrl()), autoscaled: true });
    const [node] = await db.select().from(schema.nodes).where(eq(schema.nodes.id, id));
    return node ?? null;
  };
  const next = creating.then(run, run);
  creating = next.catch(() => {});
  return next;
}

/** Cron: keeps the configured reserve of free places, and retires servers that stayed empty. */
export async function maintainCapacity(now = new Date(), origin?: string): Promise<{ created: number; removed: number }> {
  const report = { created: 0, removed: 0 };
  const { autoscale } = await getSettings("cloud");
  if (!autoscale.enabled) return report;
  const db = await getDb();
  const { rows, free: freeNow } = await capacity();
  let free = freeNow;

  for (const { node, used } of rows.filter((r) => r.node.autoscaled)) {
    const emptySince = used === 0 ? (node.emptySince ?? now) : null;
    if ((emptySince?.getTime() ?? 0) !== (node.emptySince?.getTime() ?? 0)) await db.update(schema.nodes).set({ emptySince }).where(eq(schema.nodes.id, node.id));
    const idleMs = emptySince ? now.getTime() - emptySince.getTime() : 0;
    // Only when the reserve survives without it: never remove the room we were asked to keep.
    if (autoscale.removeEmptyAfterHours > 0 && used === 0 && node.lastSeenAt && idleMs >= autoscale.removeEmptyAfterHours * 3_600_000 && free - node.maxWorkloads >= autoscale.minFreeSlots) {
      try {
        await destroyCloudServer(node.id);
        await db.delete(schema.nodes).where(eq(schema.nodes.id, node.id));
        free -= node.maxWorkloads;
        report.removed++;
      } catch {
        // Provider unreachable: try again on the next run.
      }
    }
  }
  // A machine that never reported in: its waiting sites must not look like they are still being created.
  for (const { node } of rows.filter((r) => r.node.autoscaled && !r.node.lastSeenAt && now.getTime() - r.node.createdAt.getTime() > PENDING_FOR_MS)) {
    await db.update(schema.workloads).set({ status: "error", statusMessage: "The new server did not come online. Our team has been alerted." }).where(and(eq(schema.workloads.nodeId, node.id), eq(schema.workloads.status, "creating")));
    await audit(null, "node.never_online", "node", node.id, { provider: node.provider });
  }
  // One server per run: the next run sees it in the count and adds another only if still short.
  if (free < autoscale.minFreeSlots && (await autoscaleNode(undefined, origin, true).catch(() => null))) report.created++;
  return report;
}
