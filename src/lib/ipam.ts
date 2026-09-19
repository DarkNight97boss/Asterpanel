/** IPv4 arithmetic for address pools. Pure. */

const toInt = (ip: string) => ip.split(".").reduce((n, o) => n * 256 + Number(o), 0);
const toIp = (n: number) => [24, 16, 8, 0].map((s) => Math.floor(n / 2 ** s) % 256).join(".");

export const isIpv4 = (ip: string) => /^(\d{1,3})(\.\d{1,3}){3}$/.test(ip) && ip.split(".").every((o) => Number(o) <= 255 && String(Number(o)) === o);

/** `203.0.113.0/28` → first and last address and how many can be handed out. Null when it is not a sane public-sized block. */
export function parseCidr(cidr: string): { base: number; size: number; first: number; last: number } | null {
  const m = /^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/.exec(cidr.trim());
  if (!m || !isIpv4(m[1])) return null;
  const bits = Number(m[2]);
  // Anything wider than a /16 is almost certainly a typo, and would be enumerated in memory.
  if (bits < 16 || bits > 32) return null;
  const size = 2 ** (32 - bits);
  const base = Math.floor(toInt(m[1]) / size) * size;
  if (base !== toInt(m[1])) return null; // host bits set: 203.0.113.5/28 is not a block
  // Network and broadcast addresses are left alone in blocks that have them.
  const skip = bits >= 31 ? 0 : 1;
  return { base, size, first: base + skip, last: base + size - 1 - skip };
}

export const cidrContains = (cidr: string, ip: string) => {
  const c = parseCidr(cidr);
  return !!c && isIpv4(ip) && toInt(ip) >= c.base && toInt(ip) < c.base + c.size;
};

/** Lowest address of the block that nobody holds, or null when the block is exhausted. */
export function nextFreeAddress(cidr: string, taken: string[]): string | null {
  const c = parseCidr(cidr);
  if (!c) return null;
  const used = new Set(taken.filter(isIpv4).map(toInt));
  for (let n = c.first; n <= c.last; n++) if (!used.has(n)) return toIp(n);
  return null;
}

export const blockCapacity = (cidr: string) => {
  const c = parseCidr(cidr);
  return c ? c.last - c.first + 1 : 0;
};

const PRIVATE = [["10.0.0.0", 8], ["172.16.0.0", 12], ["192.168.0.0", 16], ["127.0.0.0", 8], ["169.254.0.0", 16], ["100.64.0.0", 10], ["0.0.0.0", 8], ["224.0.0.0", 3]] as const;
/** Public unicast space only: a pool of private addresses would never be reachable by customers' visitors. */
export function isPublicCidr(cidr: string): boolean {
  const c = parseCidr(cidr);
  if (!c) return false;
  return !PRIVATE.some(([net, bits]) => {
    const size = 2 ** (32 - bits);
    const start = toInt(net);
    return c.base < start + size && c.base + c.size > start;
  });
}
