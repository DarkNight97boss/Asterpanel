import type { ProvisioningModule } from "./types";

/**
 * No automation: staff fulfils the service by hand. Lifecycle changes are
 * still tracked, so billing, suspension and reporting work as usual.
 */
export const manual: ProvisioningModule = {
  id: "manual",
  name: "Manual",
  description: "No automation. Staff activates and manages the service by hand.",
  requiresServer: false,
  serverFields: [],
  productFields: [],
  async create() {
    return {};
  },
  async suspend() {},
  async unsuspend() {},
  async terminate() {},
};
