import { centralnic } from "./centralnic";
import { internetbs } from "./internetbs";
import { openprovider } from "./openprovider";
import type { RegistrarModule } from "./types";

/** Register new registrar modules here. */
export const registrarModules: RegistrarModule[] = [internetbs, centralnic, openprovider];

export const getRegistrar = (id: string) => registrarModules.find((m) => m.id === id);

export * from "./types";
