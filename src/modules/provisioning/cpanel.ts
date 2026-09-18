import { randomBytes } from "node:crypto";
import { ModuleError, type ProvisionContext, type ProvisioningModule, type ServerConnection } from "./types";

/**
 * cPanel & WHM via WHM API 1 with an API token.
 * https://api.docs.cpanel.net/whm/introduction/
 */

type WhmResponse = { metadata?: { result?: number; reason?: string }; data?: Record<string, unknown> };

async function whm(server: ServerConnection, fn: string, params: Record<string, string> = {}) {
  const { username, apiToken, port } = server.credentials;
  if (!server.hostname || !username || !apiToken) throw new ModuleError("WHM server is missing hostname or credentials");

  const url = new URL(`https://${server.hostname}:${port || "2087"}/json-api/${fn}`);
  url.search = new URLSearchParams({ "api.version": "1", ...params }).toString();

  let res: Response;
  try {
    res = await fetch(url, {
      headers: { Authorization: `whm ${username}:${apiToken}` },
      signal: AbortSignal.timeout(60_000),
      cache: "no-store",
    });
  } catch (err) {
    throw new ModuleError(`Cannot reach WHM at ${server.hostname}`, err);
  }
  if (!res.ok) throw new ModuleError(`WHM ${fn} failed with HTTP ${res.status}`);

  const body = (await res.json()) as WhmResponse;
  if (body.metadata?.result !== 1) throw new ModuleError(body.metadata?.reason ?? `WHM ${fn} failed`, body);
  return body;
}

function requireServer(ctx: ProvisionContext): ServerConnection {
  if (!ctx.server) throw new ModuleError("No server assigned to this service");
  return ctx.server;
}

/** cPanel usernames: start with a letter, a–z0–9, max 16 chars. */
function usernameFor(domain: string): string {
  const base = domain.toLowerCase().replace(/[^a-z0-9]/g, "").replace(/^[0-9]+/, "").slice(0, 8) || "user";
  return `${base}${randomBytes(3).toString("hex")}`.slice(0, 16);
}

const notFound = (err: unknown) => err instanceof ModuleError && /does not exist|no such user/i.test(err.message);

export const cpanel: ProvisioningModule = {
  id: "cpanel",
  name: "cPanel & WHM",
  description: "Creates and manages cPanel accounts through the WHM API.",
  requiresServer: true,
  serverFields: [
    { name: "username", label: "WHM username", type: "text", placeholder: "root", required: true },
    { name: "apiToken", label: "API token", type: "password", required: true, help: "WHM → Development → Manage API Tokens" },
    { name: "port", label: "Port", type: "number", placeholder: "2087" },
  ],
  productFields: [{ name: "package", label: "WHM package name", type: "text", required: true }],

  async testConnection(server) {
    try {
      const res = await whm(server, "version");
      return { ok: true, message: `Connected — WHM ${String(res.data?.version ?? "")}`.trim() };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : "Connection failed" };
    }
  },

  async create(ctx) {
    const server = requireServer(ctx);
    if (!ctx.service.domain) throw new ModuleError("A domain is required to create a cPanel account");
    // Idempotency: a retry after a partial failure must not create a second account.
    if (ctx.service.username) return { username: ctx.service.username };

    const username = usernameFor(ctx.service.domain);
    await whm(server, "createacct", {
      username,
      domain: ctx.service.domain,
      plan: ctx.product.moduleConfig.package ?? "",
      contactemail: ctx.client.email,
      password: randomBytes(18).toString("base64url"),
    });
    return {
      username,
      message: "Your account is ready. Use “Reset password” in cPanel login to choose your password.",
    };
  },

  async suspend(ctx, reason) {
    await whm(requireServer(ctx), "suspendacct", { user: ctx.service.username, reason });
  },

  async unsuspend(ctx) {
    await whm(requireServer(ctx), "unsuspendacct", { user: ctx.service.username });
  },

  async terminate(ctx) {
    if (!ctx.service.username) return;
    try {
      await whm(requireServer(ctx), "removeacct", { user: ctx.service.username });
    } catch (err) {
      if (!notFound(err)) throw err; // already gone → terminate is idempotent
    }
  },

  loginUrl(ctx) {
    return ctx.server ? `https://${ctx.server.hostname}:2083/` : null;
  },
};
