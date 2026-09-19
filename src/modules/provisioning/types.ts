import type { schema } from "@/db";

/**
 * Provisioning module contract.
 *
 * A module connects AsterPanel to whatever actually hosts the service: a
 * control panel (cPanel/WHM, Plesk…), a hypervisor, a custom API. The billing
 * engine calls these hooks on lifecycle events and never talks to a server
 * directly. To add an integration, implement this interface and register it in
 * `./index.ts`.
 *
 * Every hook must be idempotent: the engine may retry after a failure.
 */

export type ModuleField = {
  name: string;
  label: string;
  type: "text" | "password" | "number" | "select";
  options?: { value: string; label: string }[];
  placeholder?: string;
  help?: string;
  required?: boolean;
};

export type ServerConnection = {
  id: string;
  name: string;
  hostname: string;
  /** Decrypted values of the module's `serverFields`. */
  credentials: Record<string, string>;
};

export type ProvisionContext = {
  service: typeof schema.services.$inferSelect;
  product: typeof schema.products.$inferSelect;
  client: Pick<typeof schema.users.$inferSelect, "id" | "email" | "firstName" | "lastName" | "company">;
  server: ServerConnection | null;
};

export type ProvisionResult = {
  username?: string;
  /** Merged into `services.module_data`. Do not store plaintext passwords. */
  moduleData?: Record<string, unknown>;
  /** One-time info shown to the client right after activation. */
  message?: string;
};

export interface ProvisioningModule {
  id: string;
  name: string;
  description: string;
  /** Whether this module needs a row in `servers` to work. */
  requiresServer: boolean;
  serverFields: ModuleField[];
  productFields: ModuleField[];
  testConnection?(server: ServerConnection): Promise<{ ok: boolean; message: string }>;
  create(ctx: ProvisionContext): Promise<ProvisionResult>;
  /** Called after the service moved to another product of the same kind (`ctx.product` is the new one). */
  changePlan?(ctx: ProvisionContext): Promise<void>;
  /** Called when a renewal invoice is paid, for services that must be renewed somewhere else (domains). */
  renew?(ctx: ProvisionContext): Promise<void>;
  suspend(ctx: ProvisionContext, reason: string): Promise<void>;
  unsuspend(ctx: ProvisionContext): Promise<void>;
  terminate(ctx: ProvisionContext): Promise<void>;
  /** Optional deep link to the service's own control panel. */
  loginUrl?(ctx: ProvisionContext): string | null;
}

export class ModuleError extends Error {
  constructor(
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ModuleError";
  }
}
