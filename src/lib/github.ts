import "server-only";
import { createHmac, createSign } from "node:crypto";
import { and, eq, ne } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { safeEqual, signValue, verifyValue } from "./crypto";
import { getSettings } from "./settings";

/**
 * GitHub App integration: customers install the hosting company's app on their
 * repositories, and from then on pushes deploy by themselves, private
 * repositories clone with short-lived tokens, and commits show the result.
 */

let http: typeof fetch = (...args) => fetch(...args);
export const setGithubHttpForTests = (fake: typeof fetch) => void (http = fake);

export class GithubError extends Error {}

const API = "https://api.github.com";
const b64 = (v: string) => Buffer.from(v).toString("base64url");

/** `owner/name` from an https GitHub URL, or null for anything else. */
export function githubRepoOf(repoUrl: string): string | null {
  const m = /^https:\/\/github\.com\/([\w.-]{1,39})\/([\w.-]{1,100}?)(?:\.git)?\/?$/i.exec(repoUrl.trim());
  return m && !m[1].startsWith(".") && !m[2].startsWith(".") ? `${m[1]}/${m[2]}` : null;
}

async function config() {
  const c = await getSettings("github");
  if (!c.enabled || !c.appId || !c.privateKey) throw new GithubError("The GitHub integration is not configured");
  return c;
}

/** Ten-minute JWT that proves we are the app (RS256 with the app's private key). */
export function appJwt(appId: string, privateKey: string, now = new Date()): string {
  const iat = Math.floor(now.getTime() / 1000) - 30; // tolerate a little clock drift
  const unsigned = `${b64(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${b64(JSON.stringify({ iat, exp: iat + 570, iss: appId }))}`;
  return `${unsigned}.${createSign("RSA-SHA256").update(unsigned).sign(privateKey).toString("base64url")}`;
}

async function gh<T>(path: string, init: { method?: string; token: string; body?: unknown }): Promise<T> {
  const res = await http(`${API}${path}`, { method: init.method ?? "GET", headers: { Authorization: `Bearer ${init.token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "AsterPanel", ...(init.body ? { "Content-Type": "application/json" } : {}) }, body: init.body ? JSON.stringify(init.body) : undefined, signal: AbortSignal.timeout(20_000) });
  const json = (await res.json().catch(() => ({}))) as T & { message?: string };
  if (!res.ok) throw new GithubError(json.message ?? `GitHub answered ${res.status}`);
  return json;
}

/** One-hour token limited to one repository, read-only on its contents plus commit statuses. */
export async function installationToken(installationId: string, repo: string): Promise<string> {
  if (!/^\d+$/.test(installationId)) throw new GithubError("Invalid installation");
  const c = await config();
  const r = await gh<{ token: string }>(`/app/installations/${installationId}/access_tokens`, { method: "POST", token: appJwt(c.appId, c.privateKey), body: { repositories: [repo.split("/")[1]], permissions: { contents: "read", statuses: "write" } } });
  return r.token;
}

// ─── Connecting a workload ───────────────────────────────────────────────────

/** Where the customer goes to install the app. `state` ties the way back to this workload and user. */
export async function installUrl(workloadId: string, userId: string): Promise<string> {
  const c = await config();
  if (!/^[\w-]+$/.test(c.slug)) throw new GithubError("The GitHub integration is not configured");
  return `https://github.com/apps/${c.slug}/installations/new?state=${encodeURIComponent(signValue(`${workloadId}:${userId}`, 30 * 60_000))}`;
}

/** The workload a signed `state` was issued for, if it was issued to this user and has not expired. */
export function stateWorkload(state: string, userId: string): string | null {
  const [workloadId, issuedTo] = (verifyValue(state) ?? "").split(":");
  return workloadId && issuedTo === userId ? workloadId : null;
}

/**
 * Completes the installation. The installation id in the return URL is only a
 * claim: anyone could paste someone else's. It is accepted only if the GitHub
 * user who just authorised us (the OAuth `code`) can really see that
 * installation, and the installation really covers the workload's repository.
 */
export async function connectInstallation(input: { state: string; installationId: string; code: string; userId: string }): Promise<string> {
  const [workloadId, userId] = (verifyValue(input.state) ?? "").split(":");
  if (!workloadId || userId !== input.userId) throw new GithubError("This link has expired. Start again from the Deployments page.");
  if (!/^\d+$/.test(input.installationId) || !input.code) throw new GithubError("GitHub did not confirm who is installing the app. In the app's settings, enable “Request user authorization (OAuth) during installation”.");
  const c = await config();
  const db = await getDb();
  const [w] = await db.select().from(schema.workloads).where(and(eq(schema.workloads.id, workloadId), ne(schema.workloads.status, "deleted")));
  const repo = w && githubRepoOf(w.config.repoUrl ?? "");
  if (!w || !repo) throw new GithubError("This service is not deployed from a GitHub repository");

  const tokenRes = await http("https://github.com/login/oauth/access_token", { method: "POST", headers: { Accept: "application/json", "Content-Type": "application/json" }, body: JSON.stringify({ client_id: c.clientId, client_secret: c.clientSecret, code: input.code }), signal: AbortSignal.timeout(20_000) });
  const { access_token: userToken } = (await tokenRes.json().catch(() => ({}))) as { access_token?: string };
  if (!userToken) throw new GithubError("GitHub did not confirm who is installing the app");
  const mine = await gh<{ installations: { id: number }[] }>("/user/installations?per_page=100", { token: userToken });
  if (!mine.installations.some((i) => String(i.id) === input.installationId)) throw new GithubError("This GitHub account has no access to that installation");

  // Minting a token for exactly this repository fails unless the installation covers it.
  await installationToken(input.installationId, repo).catch(() => {
    throw new GithubError(`The app is not installed on ${repo}. Add the repository to the installation on GitHub and try again.`);
  });
  await db.update(schema.workloads).set({ githubInstallationId: input.installationId, githubRepo: repo }).where(eq(schema.workloads.id, w.id));
  return w.id;
}

export async function disconnectGithub(workloadId: string) {
  await (await getDb()).update(schema.workloads).set({ githubInstallationId: "", githubRepo: "" }).where(eq(schema.workloads.id, workloadId));
}

// ─── Webhooks ────────────────────────────────────────────────────────────────

export async function verifyGithubSignature(payload: string, header: string | null): Promise<boolean> {
  const { webhookSecret } = await getSettings("github");
  if (!webhookSecret || !header?.startsWith("sha256=")) return false;
  return safeEqual(header.slice(7), createHmac("sha256", webhookSecret).update(payload).digest("hex"));
}

/** Live workloads that deploy from this repository through this installation. */
export async function workloadsForPush(repo: string, installationId: string) {
  const db = await getDb();
  return db.select().from(schema.workloads).where(and(eq(schema.workloads.githubRepo, repo), eq(schema.workloads.githubInstallationId, installationId), eq(schema.workloads.environment, "live"), ne(schema.workloads.status, "deleted")));
}

/** The app was removed on GitHub: forget the installation everywhere. */
export async function forgetInstallation(installationId: string) {
  await (await getDb()).update(schema.workloads).set({ githubInstallationId: "", githubRepo: "" }).where(eq(schema.workloads.githubInstallationId, installationId));
}

// ─── Commit statuses ─────────────────────────────────────────────────────────

/** Shows the deploy next to the commit on GitHub. Best effort: never fails the deploy it reports on. */
export async function reportCommitStatus(w: { githubInstallationId: string; githubRepo: string }, sha: string, state: "pending" | "success" | "failure", description: string, targetUrl: string): Promise<void> {
  if (!w.githubInstallationId || !w.githubRepo || !/^[0-9a-f]{40}$/i.test(sha)) return;
  try {
    const token = await installationToken(w.githubInstallationId, w.githubRepo);
    await gh(`/repos/${w.githubRepo}/statuses/${sha}`, { method: "POST", token, body: { state, description: description.slice(0, 140), context: "asterpanel/deploy", ...(targetUrl.startsWith("https://") ? { target_url: targetUrl } : {}) } });
  } catch {
    // GitHub down, app uninstalled, permission missing: the deploy itself is unaffected.
  }
}
