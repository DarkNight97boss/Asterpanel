import type { ProvisioningModule } from "./types";

/**
 * Domain names. The work happens in `src/lib/domains.ts` through the registrar
 * modules; imported lazily because that file places orders through billing,
 * which in turn loads this registry.
 */
export const domain: ProvisioningModule = {
  id: "domain",
  name: "Domain name",
  description: "Registers, transfers and renews domain names through the configured registrars.",
  requiresServer: false,
  serverFields: [],
  productFields: [],
  async create(ctx) {
    const { provisionDomain } = await import("@/lib/domains");
    const request = (ctx.service.moduleData.request ?? {}) as { action?: string; authCode?: string };
    await provisionDomain(ctx.service.id, request);
    // The transfer code has served its purpose: only the action is kept.
    return { moduleData: { request: { action: request.action } } };
  },
  async renew(ctx) {
    const { renewDomain } = await import("@/lib/domains");
    await renewDomain(ctx.service.id);
  },
  // A domain cannot be "suspended": unpaid renewals simply let it expire at the registry.
  async suspend() {},
  async unsuspend() {},
  async terminate() {},
};
