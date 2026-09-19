import "server-only";
import { and, asc, eq, isNull } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { CloudError, getCloudProvider, type ReservedIp } from "@/modules/cloud";
import { audit } from "./audit";
import { cloudAccount, cloudHttp } from "./cloud";
import { blockCapacity, cidrContains, isPublicCidr, nextFreeAddress } from "./ipam";

/**
 * Address pools. The administrator decides which public addresses nodes get:
 * a block the company owns and brought to the provider, or addresses reserved
 * at the provider and kept. New servers lease one by themselves; an address
 * freed by a deleted server is the first to be handed out again.
 */

export class IpPoolError extends Error {}

/** A pool serves a server when the provider matches and the server's region lies in the pool's (GCP zones sit inside regions). */
const serves = (pool: { provider: string; region: string }, provider: string, region: string) => pool.provider === provider && (region === pool.region || region.startsWith(`${pool.region}-`));

export async function createIpPool(input: { name: string; provider: string; region: string; mode: "block" | "reserved"; cidr: string; autoLease: boolean }, actorId: string | null = null): Promise<string> {
  const provider = getCloudProvider(input.provider);
  if (!provider?.reserveIp) throw new IpPoolError("This provider cannot reserve addresses");
  const name = input.name.trim().slice(0, 60);
  const region = input.region.trim().toLowerCase();
  if (!name || !/^[a-z0-9][a-z0-9-]{1,40}$/.test(region)) throw new IpPoolError("Give the pool a name and a region");
  const cidr = input.mode === "block" ? input.cidr.trim() : "";
  if (input.mode === "block") {
    if (input.provider === "hetzner") throw new IpPoolError("Hetzner Cloud cannot host your own block: use a pool of reserved addresses there");
    if (!isPublicCidr(cidr)) throw new IpPoolError("Enter a public IPv4 block such as 203.0.113.0/28 (between /16 and /32, on its boundary)");
    const db = await getDb();
    const others = await db.select().from(schema.ipPools).where(eq(schema.ipPools.mode, "block"));
    // Two pools over the same space would lease the same address twice.
    const clash = others.find((o) => cidrContains(o.cidr, cidr.split("/")[0]) || cidrContains(cidr, o.cidr.split("/")[0]));
    if (clash) throw new IpPoolError(`This block overlaps the pool “${clash.name}”`);
  }
  const [row] = await (await getDb()).insert(schema.ipPools).values({ name, provider: input.provider, region, mode: input.mode, cidr, autoLease: input.autoLease }).returning({ id: schema.ipPools.id });
  await audit(actorId, "ippool.created", "ip_pool", row.id, { provider: input.provider, region, mode: input.mode, cidr });
  return row.id;
}

/**
 * An address for a new server, or null when no pool covers it. Order: an
 * address already reserved and free, then the next one of an owned block,
 * then a fresh reservation. The lease row is written before the server
 * exists, so two servers created together can never get the same address.
 */
export async function leaseAddress(providerId: string, region: string, nodeId: string): Promise<ReservedIp | null> {
  const db = await getDb();
  const pools = (await db.select().from(schema.ipPools).where(and(eq(schema.ipPools.enabled, true), eq(schema.ipPools.autoLease, true))).orderBy(asc(schema.ipPools.createdAt))).filter((p) => serves(p, providerId, region));
  for (const pool of pools) {
    // 1. Re-use: claimed with a conditional update, so a concurrent lease loses cleanly.
    const free = await db.select().from(schema.ipLeases).where(and(eq(schema.ipLeases.poolId, pool.id), isNull(schema.ipLeases.nodeId))).orderBy(asc(schema.ipLeases.createdAt));
    for (const lease of free) {
      const [mine] = await db.update(schema.ipLeases).set({ nodeId, leasedAt: new Date() }).where(and(eq(schema.ipLeases.id, lease.id), isNull(schema.ipLeases.nodeId))).returning();
      if (mine) return { ref: mine.providerRef, address: mine.address };
    }
    // 2./3. A new reservation at the provider.
    const { provider, creds } = await cloudAccount(providerId);
    if (!provider.reserveIp) continue;
    let wanted: string | undefined;
    if (pool.mode === "block") {
      const taken = (await db.select({ address: schema.ipLeases.address }).from(schema.ipLeases).where(eq(schema.ipLeases.poolId, pool.id))).map((l) => l.address);
      wanted = nextFreeAddress(pool.cidr, taken) ?? undefined;
      if (!wanted) continue; // block exhausted: try the next pool
    }
    const reserved = await provider.reserveIp(creds, { name: `aster-ip-${nodeId.slice(0, 8)}-${Date.now().toString(36)}`, region: pool.region, address: wanted }, cloudHttp());
    try {
      await db.insert(schema.ipLeases).values({ poolId: pool.id, address: reserved.address, providerRef: reserved.ref, nodeId, leasedAt: new Date() });
    } catch {
      // Somebody else holds this address (unique index): do not keep paying for a reservation we cannot use.
      await provider.releaseIp?.(creds, reserved.ref, pool.region, cloudHttp()).catch(() => {});
      continue;
    }
    return reserved;
  }
  return null;
}

/** The server was not created after all: the address goes back to the pool, still reserved. */
export async function unlease(nodeId: string) {
  await (await getDb()).update(schema.ipLeases).set({ nodeId: null, leasedAt: null }).where(eq(schema.ipLeases.nodeId, nodeId));
}

/** Gives a free address back to the provider, so it stops being billed. Leased addresses are refused. */
export async function releaseAddress(leaseId: string, actorId: string | null = null) {
  const db = await getDb();
  const [row] = await db.select({ lease: schema.ipLeases, pool: schema.ipPools }).from(schema.ipLeases).innerJoin(schema.ipPools, eq(schema.ipPools.id, schema.ipLeases.poolId)).where(eq(schema.ipLeases.id, leaseId));
  if (!row) throw new IpPoolError("Address not found");
  if (row.lease.nodeId) throw new IpPoolError("This address is in use by a server");
  const { provider, creds } = await cloudAccount(row.pool.provider).catch(() => {
    throw new IpPoolError("Enable the provider again to release its addresses");
  });
  try {
    await provider.releaseIp?.(creds, row.lease.providerRef, row.pool.region, cloudHttp());
  } catch (err) {
    throw new IpPoolError(err instanceof CloudError ? err.message : "The cloud provider could not be reached");
  }
  await db.delete(schema.ipLeases).where(eq(schema.ipLeases.id, row.lease.id));
  await audit(actorId, "ippool.address_released", "ip_pool", row.pool.id, { address: row.lease.address });
}

export async function deleteIpPool(poolId: string, actorId: string | null = null) {
  const db = await getDb();
  const [held] = await db.select({ id: schema.ipLeases.id }).from(schema.ipLeases).where(eq(schema.ipLeases.poolId, poolId)).limit(1);
  if (held) throw new IpPoolError("Release the pool's addresses first");
  await db.delete(schema.ipPools).where(eq(schema.ipPools.id, poolId));
  await audit(actorId, "ippool.deleted", "ip_pool", poolId);
}

export async function poolUsage() {
  const db = await getDb();
  const [pools, leases] = await Promise.all([db.select().from(schema.ipPools).orderBy(asc(schema.ipPools.createdAt)), db.select({ lease: schema.ipLeases, node: schema.nodes.name }).from(schema.ipLeases).leftJoin(schema.nodes, eq(schema.nodes.id, schema.ipLeases.nodeId)).orderBy(asc(schema.ipLeases.address))]);
  return pools.map((pool) => {
    const mine = leases.filter((l) => l.lease.poolId === pool.id);
    return { pool, leases: mine, inUse: mine.filter((l) => l.lease.nodeId).length, capacity: pool.mode === "block" ? blockCapacity(pool.cidr) : null };
  });
}
