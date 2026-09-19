import { createSign } from "node:crypto";
import { CloudError, SLUG, type CloudCredentials, type CloudProvider, type CloudServer, type Http } from "./types";

/**
 * Google Compute Engine — REST, authenticated with a service-account key:
 * a short-lived RS256 JWT is exchanged for an access token. No SDK.
 */

type Account = { client_email: string; private_key: string; project_id: string; token_uri?: string };

export function parseServiceAccount(json: string): Account {
  let a: Partial<Account>;
  try {
    a = JSON.parse(json) as Partial<Account>;
  } catch {
    throw new CloudError("The service account key is not valid JSON");
  }
  if (!a.client_email || !a.private_key?.includes("PRIVATE KEY") || !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(a.project_id ?? "")) throw new CloudError("The service account key must contain client_email, private_key and project_id");
  return a as Account;
}

const b64 = (v: string | Buffer) => Buffer.from(v).toString("base64url");

export function serviceAccountJwt(a: Account, now = new Date()): string {
  const iat = Math.floor(now.getTime() / 1000);
  const unsigned = `${b64(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${b64(JSON.stringify({ iss: a.client_email, scope: "https://www.googleapis.com/auth/compute", aud: "https://oauth2.googleapis.com/token", iat, exp: iat + 600 }))}`;
  return `${unsigned}.${createSign("RSA-SHA256").update(unsigned).sign(a.private_key).toString("base64url")}`;
}

async function session(c: CloudCredentials, http: Http) {
  const account = parseServiceAccount(c.serviceAccountJson ?? "");
  const res = await http("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: serviceAccountJwt(account) }), signal: AbortSignal.timeout(30_000) });
  const json = (await res.json().catch(() => ({}))) as { access_token?: string; error_description?: string };
  if (!res.ok || !json.access_token) throw new CloudError(json.error_description ?? "Google refused the service account");
  return { token: json.access_token, project: account.project_id };
}

async function call<T>(c: CloudCredentials, http: Http, method: string, path: (project: string) => string, body?: unknown): Promise<T> {
  const { token, project } = await session(c, http);
  const res = await http(`https://compute.googleapis.com/compute/v1/projects/${project}${path(project)}`, { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
  const json = (await res.json().catch(() => ({}))) as T & { error?: { message?: string } };
  if (res.status === 404) throw new CloudError("not_found");
  if (!res.ok) throw new CloudError(json.error?.message ?? `Google answered ${res.status}`);
  return json;
}

type Instance = { name: string; status: string; networkInterfaces?: { accessConfigs?: { natIP?: string }[] }[] };
const view = (i: Instance): CloudServer => ({ id: i.name, ip: i.networkInterfaces?.[0]?.accessConfigs?.[0]?.natIP ?? "", status: i.status === "RUNNING" ? "running" : i.status === "TERMINATED" || i.status === "STOPPED" || i.status === "SUSPENDED" ? "stopped" : "starting" });
const zoneOk = (z: string) => /^[a-z]+-[a-z]+\d-[a-z]$/.test(z);

export const gcp: CloudProvider = {
  id: "gcp",
  name: "Google Cloud (Compute Engine)",
  website: "https://cloud.google.com/compute",
  fields: [{ name: "serviceAccountJson", label: "Service account key (JSON)", type: "textarea", help: "A service account with the Compute Instance Admin (v1) role. Paste the whole key file. Allow HTTP and HTTPS in the project's firewall for the tags http-server and https-server." }],
  regions: [["europe-west8-a", "Milan"], ["europe-west3-a", "Frankfurt"], ["europe-west1-b", "Belgium"], ["europe-west4-a", "Netherlands"], ["us-central1-a", "Iowa"], ["us-east1-b", "South Carolina"], ["asia-southeast1-a", "Singapore"]].map(([id, label]) => ({ id, label: `${label} (${id})` })),
  sizes: [["e2-small", "2 vCPU shared · 2 GB"], ["e2-medium", "2 vCPU shared · 4 GB"], ["e2-standard-2", "2 vCPU · 8 GB"], ["e2-standard-4", "4 vCPU · 16 GB"], ["n2-standard-4", "4 vCPU · 16 GB"]].map(([id, label]) => ({ id, label: `${id} — ${label}` })),

  async test(c, http) {
    await call(c, http, "GET", () => "/zones?maxResults=1");
    return "Connected";
  },
  async create(c, s, http) {
    if (!zoneOk(s.region)) throw new CloudError("Choose a zone such as europe-west8-a");
    if (!SLUG.test(s.size)) throw new CloudError("Invalid machine type");
    await call(c, http, "POST", () => `/zones/${s.region}/instances`, {
      name: s.name,
      machineType: `zones/${s.region}/machineTypes/${s.size}`,
      labels: { "managed-by": "asterpanel" },
      tags: { items: ["http-server", "https-server"] },
      disks: [{ boot: true, autoDelete: true, initializeParams: { sourceImage: "projects/ubuntu-os-cloud/global/images/family/ubuntu-2404-lts-amd64", diskSizeGb: "60", diskType: `zones/${s.region}/diskTypes/pd-balanced` } }],
      networkInterfaces: [{ network: "global/networks/default", accessConfigs: [{ type: "ONE_TO_ONE_NAT", name: "External NAT" }] }],
      metadata: { items: [{ key: "startup-script", value: s.bootScript }] },
      shieldedInstanceConfig: { enableSecureBoot: true, enableVtpm: true, enableIntegrityMonitoring: true },
    });
    // The insert is asynchronous: the instance is addressed by its name from now on.
    return { id: s.name, status: "starting", ip: "" };
  },
  async get(c, id, region, http) {
    if (!zoneOk(region) || !SLUG.test(id)) throw new CloudError("Invalid instance");
    try {
      return view(await call<Instance>(c, http, "GET", () => `/zones/${region}/instances/${id}`));
    } catch (err) {
      if (err instanceof CloudError && err.message === "not_found") return { id, status: "gone", ip: "" };
      throw err;
    }
  },
  async destroy(c, id, region, http) {
    if (!zoneOk(region) || !SLUG.test(id)) throw new CloudError("Invalid instance");
    await call(c, http, "DELETE", () => `/zones/${region}/instances/${id}`).catch((err) => {
      if (!(err instanceof CloudError && err.message === "not_found")) throw err;
    });
  },
};
