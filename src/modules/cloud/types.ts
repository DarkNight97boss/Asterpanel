/**
 * Cloud provider contract: create, look up and destroy the virtual machines
 * that become nodes. Physical servers need none of this — they are added by
 * running the installer on them. To add a provider: implement this interface
 * and register it in `./index.ts`.
 */

export type CloudField = { name: string; label: string; type: "text" | "password" | "textarea"; help?: string; optional?: boolean };
export type CloudCredentials = Record<string, string>;
export type Http = typeof fetch;

export type CloudOption = { id: string; label: string };

export type NewServer = {
  /** DNS-safe: lower case letters, digits and dashes. */
  name: string;
  region: string;
  size: string;
  /** Shell script run as root on first boot; installs Docker and the agent. */
  bootScript: string;
};

export type CloudServer = { id: string; status: "starting" | "running" | "stopped" | "gone"; ip: string };

export class CloudError extends Error {}

export interface CloudProvider {
  id: string;
  name: string;
  website: string;
  fields: CloudField[];
  /** Offered in the form; free text is accepted too, since providers add regions and sizes all the time. */
  regions: CloudOption[];
  sizes: CloudOption[];
  /** Cheap authenticated call that proves the credentials work. */
  test(c: CloudCredentials, http: Http): Promise<string>;
  create(c: CloudCredentials, server: NewServer, http: Http): Promise<CloudServer>;
  get(c: CloudCredentials, id: string, region: string, http: Http): Promise<CloudServer>;
  destroy(c: CloudCredentials, id: string, region: string, http: Http): Promise<void>;
}

export const SERVER_NAME = /^[a-z]([a-z0-9-]{0,48}[a-z0-9])?$/;
export const SLUG = /^[a-z0-9][a-z0-9.-]{0,40}$/i;
