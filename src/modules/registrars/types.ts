/**
 * Registrar module contract.
 *
 * A registrar module talks to one domain reseller API. The domain engine
 * (`src/lib/domains.ts`) picks the module configured for a TLD and never calls
 * an API directly. To add a registrar: implement this interface and register
 * it in `./index.ts`.
 *
 * Modules receive `fetch` from the caller so tests can run without a network.
 */

export type RegistrarField = { name: string; label: string; type: "text" | "password"; help?: string };

export type RegistrarCredentials = Record<string, string> & { sandbox?: string };

/** One person or organisation, used for all four contact roles. */
export type DomainContact = {
  firstName: string;
  lastName: string;
  organization: string;
  email: string;
  /** International format `+39.0612345678`. */
  phone: string;
  address: string;
  city: string;
  zip: string;
  state: string;
  /** ISO 3166-1 alpha-2. */
  country: string;
  /** National tax / company code; required by some ccTLDs (.it). */
  taxCode: string;
};

export type DomainInfo = {
  status: "active" | "expired" | "pending" | "transferring" | "unknown";
  expiresAt: Date | null;
  nameservers: string[];
  locked: boolean;
};

export class RegistrarError extends Error {}

export type Http = typeof fetch;

export interface RegistrarModule {
  id: string;
  name: string;
  website: string;
  fields: RegistrarField[];
  /** Proves the credentials work; the message usually carries the account balance. */
  test(c: RegistrarCredentials, http: Http): Promise<string>;
  /** Availability of each name, in the order given. */
  check(c: RegistrarCredentials, domains: string[], http: Http): Promise<{ domain: string; available: boolean }[]>;
  register(c: RegistrarCredentials, input: { domain: string; years: number; contact: DomainContact; nameservers: string[] }, http: Http): Promise<void>;
  transfer(c: RegistrarCredentials, input: { domain: string; authCode: string; contact: DomainContact; nameservers: string[] }, http: Http): Promise<void>;
  renew(c: RegistrarCredentials, input: { domain: string; years: number; currentExpiry: Date | null }, http: Http): Promise<void>;
  info(c: RegistrarCredentials, domain: string, http: Http): Promise<DomainInfo>;
  setNameservers(c: RegistrarCredentials, domain: string, nameservers: string[], http: Http): Promise<void>;
  setLock(c: RegistrarCredentials, domain: string, locked: boolean, http: Http): Promise<void>;
  authCode(c: RegistrarCredentials, domain: string, http: Http): Promise<string>;
}

/** Italian registry: 1 = natural person, 2 = company, per NIC.it. */
export const itEntityType = (contact: DomainContact) => (contact.organization ? "2" : "1");
