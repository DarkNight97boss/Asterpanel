import { WORKLOAD_TYPES, type WorkloadConfig, type WorkloadType } from "@/db/schema";
import { decryptJson, encryptJson } from "@/lib/crypto";
import { createWorkload, deleteWorkload, suspendWorkload, unsuspendWorkload, updateWorkloadConfig } from "@/platform/engine";
import { ModuleError, type ProvisionContext, type ProvisioningModule } from "./types";

/**
 * Aster Platform: the built-in engine. A paid plan becomes a workload
 * (WordPress site, app, database or static site) on one of your own nodes.
 *
 * What the client typed when ordering (site name, repository, PHP version…)
 * travels in `service.moduleData.request`; plan limits come from the product.
 */

/** `sealed` is an encrypted `{ env, accessToken }`: secrets never sit in plain text on the order. */
export type PlatformRequest = { name?: string; region?: string; config?: WorkloadConfig; sealed?: string; /** WordPress: start as a copy of this site of the same company. */ cloneFrom?: string };
type Sealed = { env?: Record<string, string>; accessToken?: string };

export const sealRequestSecrets = (secrets: Sealed) => encryptJson(secrets);

const workloadId = (ctx: ProvisionContext) => (typeof ctx.service.moduleData.workloadId === "string" ? ctx.service.moduleData.workloadId : null);

export const planType = (moduleConfig: Record<string, string>): WorkloadType =>
  WORKLOAD_TYPES.find((t) => t === moduleConfig.type) ?? "wordpress";

export const platform: ProvisioningModule = {
  id: "platform",
  name: "Aster Platform",
  description: "Managed WordPress, applications, databases and static sites on your own nodes.",
  requiresServer: false,
  serverFields: [],
  productFields: [
    { name: "type", label: "Service type", type: "select", options: WORKLOAD_TYPES.map((t) => ({ value: t, label: t })), required: true },
    { name: "memoryMb", label: "Memory (MB)", type: "number", placeholder: "512" },
    { name: "cpus", label: "CPU cores", type: "number", placeholder: "1" },
    { name: "diskGb", label: "Disk (GB)", type: "number", placeholder: "10" },
  ],

  async create(ctx) {
    const existing = workloadId(ctx);
    if (existing) return { moduleData: { workloadId: existing } }; // retry-safe

    const request = (ctx.service.moduleData.request ?? {}) as PlatformRequest;
    const sealed = decryptJson<Sealed>(request.sealed ?? "", {});
    const limit = (key: string, fallback: number) => Number(ctx.product.moduleConfig[key]) || fallback;
    try {
      const id = await createWorkload({
        clientId: ctx.client.id,
        companyId: ctx.service.companyId,
        serviceId: ctx.service.id,
        type: planType(ctx.product.moduleConfig),
        name: request.name || ctx.product.name,
        region: request.region || undefined,
        cloneFrom: request.cloneFrom || undefined,
        env: sealed.env,
        accessToken: sealed.accessToken,
        config: { ...request.config, memoryMb: limit("memoryMb", 512), cpus: limit("cpus", 1), diskGb: limit("diskGb", 10) },
      });
      // The secrets now live in the workload's own encrypted store.
      return { moduleData: { workloadId: id, request: { ...request, sealed: undefined } } };
    } catch (err) {
      throw new ModuleError(err instanceof Error ? err.message : "Provisioning failed", err);
    }
  },

  async changePlan(ctx) {
    const id = workloadId(ctx);
    const limit = (key: string, fallback: number) => Number(ctx.product.moduleConfig[key]) || fallback;
    if (id) await updateWorkloadConfig(id, { memoryMb: limit("memoryMb", 512), cpus: limit("cpus", 1), diskGb: limit("diskGb", 10) });
  },

  async suspend(ctx, reason) {
    const id = workloadId(ctx);
    if (id) await suspendWorkload(id, reason);
  },
  async unsuspend(ctx) {
    const id = workloadId(ctx);
    if (id) await unsuspendWorkload(id);
  },
  async terminate(ctx) {
    const id = workloadId(ctx);
    if (id) await deleteWorkload(id).catch(() => {}); // already gone → fine
  },
};
