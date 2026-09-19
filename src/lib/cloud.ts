import "server-only";
import { and, eq, ne } from "drizzle-orm";
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

export async function createCloudNode(input: { provider: string; name: string; region: string; size: string; baseDomain: string; maxWorkloads: number; origin: string }, actorId: string | null = null): Promise<string> {
  const { provider, creds } = await cloudAccount(input.provider);
  const name = input.name.trim().toLowerCase();
  if (!SERVER_NAME.test(name)) throw new CloudNodeError("Use lower-case letters, numbers and dashes for the server name, starting with a letter");
  if (!SLUG.test(input.region) || !SLUG.test(input.size)) throw new CloudNodeError("Choose a region and a size");
  const db = await getDb();
  const [clash] = await db.select({ id: schema.nodes.id }).from(schema.nodes).where(eq(schema.nodes.name, name));
  if (clash) throw new CloudNodeError("A server with this name already exists");

  const token = randomToken(32);
  const [node] = await db.insert(schema.nodes).values({ name, region: input.region, baseDomain: input.baseDomain, maxWorkloads: input.maxWorkloads, tokenHash: sha256(token), provider: provider.id, providerRegion: input.region, providerSize: input.size }).returning({ id: schema.nodes.id });
  try {
    const script = bootScript({ origin: input.origin, token: `${node.id}.${token}`, publicKey: (await signingKeys()).publicKey, acmeEmail: (await getSettings("cloud")).acmeEmail });
    const server = await provider.create(creds, { name, region: input.region, size: input.size, bootScript: script }, http);
    await db.update(schema.nodes).set({ providerServerId: server.id, publicIp: server.ip }).where(eq(schema.nodes.id, node.id));
  } catch (err) {
    // Nothing was created (or we cannot know what): do not leave a node that will never come online.
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
