import { acube } from "./acube";
import { aruba } from "./aruba";
import { fattureincloud } from "./fattureincloud";
import { invoicetronic } from "./invoicetronic";
import { openapi } from "./openapi";
import type { SdiProvider } from "./types";

/** Register new SDI intermediaries here. */
export const sdiProviders: SdiProvider[] = [acube, aruba, fattureincloud, invoicetronic, openapi];
export const getSdiProvider = (id: string) => sdiProviders.find((p) => p.id === id);
export * from "./types";
