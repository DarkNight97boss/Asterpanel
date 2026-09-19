import { centralnic } from "./centralnic";
import { internetbs } from "./internetbs";
import type { RegistrarModule } from "./types";

/** Register new registrar modules here. */
export const registrarModules: RegistrarModule[] = [internetbs, centralnic];

export const getRegistrar = (id: string) => registrarModules.find((m) => m.id === id);

export * from "./types";
