import { cpanel } from "./cpanel";
import { manual } from "./manual";
import { platform } from "./platform";
import type { ProvisioningModule } from "./types";

/** Register new provisioning modules here. */
export const provisioningModules: ProvisioningModule[] = [platform, manual, cpanel];

export function getProvisioningModule(id: string): ProvisioningModule {
  return provisioningModules.find((m) => m.id === id) ?? manual;
}

export * from "./types";
