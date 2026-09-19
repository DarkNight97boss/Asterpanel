import { CloudError, type CloudCredentials, type CloudProvider, type CloudServer, type Http } from "./types";

/** Hetzner Cloud — https://docs.hetzner.cloud. Bearer token, JSON. */
const API = "https://api.hetzner.cloud/v1";

type HServer = { id: number; status: string; public_net?: { ipv4?: { ip?: string } } };

async function call<T>(c: CloudCredentials, http: Http, method: string, path: string, body?: unknown): Promise<T> {
  const res = await http(`${API}${path}`, { method, headers: { Authorization: `Bearer ${c.token}`, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
  const json = (await res.json().catch(() => ({}))) as T & { error?: { message?: string; code?: string } };
  if (res.status === 404) throw new CloudError("not_found");
  if (!res.ok) throw new CloudError(json.error?.message ?? `Hetzner answered ${res.status}`);
  return json;
}

const view = (s: HServer): CloudServer => ({ id: String(s.id), ip: s.public_net?.ipv4?.ip ?? "", status: s.status === "running" ? "running" : s.status === "off" ? "stopped" : "starting" });

export const hetzner: CloudProvider = {
  id: "hetzner",
  name: "Hetzner Cloud",
  website: "https://www.hetzner.com/cloud",
  fields: [{ name: "token", label: "API token", type: "password", help: "Project → Security → API tokens, with read and write permission." }],
  regions: [["fsn1", "Falkenstein"], ["nbg1", "Nuremberg"], ["hel1", "Helsinki"], ["ash", "Ashburn, VA"], ["hil", "Hillsboro, OR"], ["sin", "Singapore"]].map(([id, label]) => ({ id, label: `${label} (${id})` })),
  sizes: [["cx22", "2 vCPU · 4 GB"], ["cx32", "4 vCPU · 8 GB"], ["cx42", "8 vCPU · 16 GB"], ["cpx31", "4 vCPU AMD · 8 GB"], ["ccx23", "4 dedicated vCPU · 16 GB"]].map(([id, label]) => ({ id, label: `${id} — ${label}` })),

  async test(c, http) {
    const r = await call<{ servers?: unknown[] }>(c, http, "GET", "/servers?per_page=1");
    return `Connected (${Array.isArray(r.servers) ? "project reachable" : "ok"})`;
  },
  async create(c, s, http) {
    // A primary IP belongs to a datacenter, so the server has to be created in that same one.
    const pinned = s.ip ? await call<{ primary_ip: { datacenter: { name: string } } }>(c, http, "GET", `/primary_ips/${s.ip.ref}`) : null;
    const where = pinned ? { datacenter: pinned.primary_ip.datacenter.name } : { location: s.region };
    const r = await call<{ server: HServer }>(c, http, "POST", "/servers", { name: s.name, server_type: s.size, ...where, image: "ubuntu-24.04", user_data: s.bootScript, start_after_create: true, labels: { "managed-by": "asterpanel" }, public_net: { enable_ipv4: true, enable_ipv6: true, ...(s.ip ? { ipv4: Number(s.ip.ref) } : {}) } });
    return view(r.server);
  },
  async reserveIp(c, input, http) {
    if (input.address) throw new CloudError("Hetzner Cloud assigns the address itself: a specific one cannot be asked for");
    const dcs = await call<{ datacenters: { name: string; location: { name: string } }[] }>(c, http, "GET", "/datacenters");
    const dc = dcs.datacenters.find((d) => d.location.name === input.region);
    if (!dc) throw new CloudError(`Hetzner has no datacenter in ${input.region}`);
    // auto_delete off: the address must outlive the server it is attached to.
    const r = await call<{ primary_ip: { id: number; ip: string } }>(c, http, "POST", "/primary_ips", { name: input.name, type: "ipv4", assignee_type: "server", datacenter: dc.name, auto_delete: false, labels: { "managed-by": "asterpanel" } });
    return { ref: String(r.primary_ip.id), address: r.primary_ip.ip };
  },
  async releaseIp(c, ref, _region, http) {
    if (!/^\d+$/.test(ref)) throw new CloudError("Invalid address reference");
    await call(c, http, "DELETE", `/primary_ips/${ref}`).catch((err) => {
      if (!(err instanceof CloudError && err.message === "not_found")) throw err;
    });
  },
  async get(c, id, _region, http) {
    if (!/^\d+$/.test(id)) throw new CloudError("Invalid server id");
    try {
      return view((await call<{ server: HServer }>(c, http, "GET", `/servers/${id}`)).server);
    } catch (err) {
      if (err instanceof CloudError && err.message === "not_found") return { id, status: "gone", ip: "" };
      throw err;
    }
  },
  async destroy(c, id, _region, http) {
    if (!/^\d+$/.test(id)) throw new CloudError("Invalid server id");
    await call(c, http, "DELETE", `/servers/${id}`).catch((err) => {
      if (!(err instanceof CloudError && err.message === "not_found")) throw err;
    });
  },
};
