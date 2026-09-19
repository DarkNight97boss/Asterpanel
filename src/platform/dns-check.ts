import "server-only";
import { Resolver } from "node:dns/promises";

export type DomainCheck = { state: "ok" | "elsewhere" | "missing" | "unknown"; found: string[] };

/**
 * Does `hostname` reach the node? Asked to public resolvers (not the local
 * one, which may be split-horizon), with a short timeout so a slow lookup can
 * never hang the page.
 */
export async function checkDomain(hostname: string, expectedIp: string): Promise<DomainCheck> {
  if (!expectedIp) return { state: "unknown", found: [] };
  const resolver = new Resolver({ timeout: 1500, tries: 1 });
  resolver.setServers(["1.1.1.1", "8.8.8.8"]);
  const lookup = (fn: () => Promise<string[]>) => fn().catch(() => [] as string[]);
  const [a, aaaa] = await Promise.all([lookup(() => resolver.resolve4(hostname)), lookup(() => resolver.resolve6(hostname))]);
  const found = [...a, ...aaaa];
  if (!found.length) return { state: "missing", found };
  return { state: found.includes(expectedIp) ? "ok" : "elsewhere", found };
}
