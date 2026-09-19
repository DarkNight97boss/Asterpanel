/** Hosts that must never be contacted on a customer's behalf: loopback, private ranges, internal names. */
const PRIVATE_HOST = /^(localhost|.*\.(local|internal|localhost|lan|home|test)|\[.*\]|127\.|10\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/i;

/** A public https URL without credentials, or null. Literal checks only: DNS is not resolved here. */
export function publicHttpsUrl(input: string): URL | null {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.href.length > 2000) return null;
  if (PRIVATE_HOST.test(url.hostname) || !url.hostname.includes(".")) return null;
  return url;
}
