import { aws } from "./aws";
import { gcp } from "./gcp";
import { hetzner } from "./hetzner";
import type { CloudProvider } from "./types";

/** Register new cloud providers here. */
export const cloudProviders: CloudProvider[] = [hetzner, aws, gcp];
export const getCloudProvider = (id: string) => cloudProviders.find((p) => p.id === id);
export * from "./types";
