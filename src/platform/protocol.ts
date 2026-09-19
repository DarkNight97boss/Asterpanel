/**
 * Control plane ⇄ agent protocol. Shared by the Next.js app and the agent
 * bundle, so this file must stay dependency-free.
 *
 * Transport: the agent makes outbound HTTPS calls only (no open port on the
 * node), authenticated with a per-node bearer token:
 *
 *   POST /api/agent/v1/poll          heartbeat + stats → signed jobs to run
 *   POST /api/agent/v1/jobs/:id      progress log, then the final result
 *
 * Every job is an envelope signed with the control plane's Ed25519 key. The
 * agent pins the public key at install time and refuses anything unsigned,
 * expired or addressed to another node — a stolen node token or a tampered
 * response cannot make a node run arbitrary work.
 */

export const PROTOCOL_VERSION = 1;

export type WorkloadKind = "wordpress" | "app" | "database" | "static";

/** Everything the agent needs to materialise a workload. Self-contained. */
export type WorkloadSpec = {
  id: string;
  /** DNS-safe unique name; containers, volumes and networks derive from it. */
  slug: string;
  kind: WorkloadKind;
  /** Owner id. Workloads of one tenant share a private network; tenants never do. */
  tenant: string;
  environment: "live" | "staging";
  /** Hostnames routed to this workload; the first one is primary. */
  domains: string[];
  resources: { memoryMb: number; cpus: number; diskGb: number };
  wordpress?: { phpVersion: string; title: string; adminUser: string; adminEmail: string; adminPassword: string; dbPassword: string; locale: string };
  database?: { engine: "mysql" | "postgres" | "redis"; version: string; name: string; user: string; password: string };
  source?: { repoUrl: string; branch: string; accessToken?: string; buildCommand?: string; outputDir?: string; port?: number };
  env?: Record<string, string>;
  /** Edge rules applied by the node's proxy. `from` is a path, `to` a path or absolute URL. */
  redirects?: { from: string; to: string; code: 301 | 302 }[];
  denyIps?: string[];
  /** Bot protection at the proxy. `ratePerMinute` 0 = no limit. */
  bots?: { blockBad: boolean; blockAi: boolean; ratePerMinute: number; protectLogin: boolean };
  /** Long-lived caching of static assets at the node's edge, plus compression. */
  cdn?: { enabled: boolean; maxAgeDays: number };
  /** Edge page cache in front of a WordPress site. */
  cache?: { enabled: boolean; ttlMinutes: number; bypass: string[] };
  /** SFTP access to the site's files (WordPress). Absent or disabled = no SFTP container. */
  sftp?: { enabled: boolean; port: number; username: string; password: string; keys?: string[] };
};

export type JobPayloads = {
  "workload.create": { spec: WorkloadSpec };
  /** Re-applies the spec: new domains, PHP version, env vars, limits. */
  "workload.update": { spec: WorkloadSpec };
  "workload.start": { spec: WorkloadSpec };
  "workload.stop": { spec: WorkloadSpec };
  "workload.restart": { spec: WorkloadSpec };
  "workload.delete": { spec: WorkloadSpec };
  /** Copies files + database of `from` into `spec` (staging ⇄ live). */
  "workload.clone": { spec: WorkloadSpec; from: WorkloadSpec };
  "workload.deploy": { spec: WorkloadSpec; deploymentId: string };
  "workload.logs": { spec: WorkloadSpec; lines: number };
  "workload.tool": { spec: WorkloadSpec; tool: ToolName; args?: Record<string, string> };
  /** Request-level performance report from the proxy's access log. */
  "workload.apm": { spec: WorkloadSpec; minutes: number };
  /** File manager on the site's files. `path` is relative to the site root. */
  "workload.files": { spec: WorkloadSpec; action: "list" | "read" | "write" | "mkdir" | "delete"; path: string; content?: string };
  /** Node-level: replace everything this node serves as an authoritative name server. */
  "dns.sync": { nameservers: string[]; hostmaster: string; zones: DnsZoneData[] };
  /** Database console: `tables` lists them with sizes, `query` runs one statement. */
  "workload.db": { spec: WorkloadSpec; action: "tables" | "query"; sql?: string };
  "backup.create": { spec: WorkloadSpec; backupId: string };
  "backup.restore": { spec: WorkloadSpec; backupId: string };
  "backup.delete": { spec: WorkloadSpec; backupId: string };
};

export type JobType = keyof JobPayloads;

export const TOOLS = ["cache.purge", "wp.cache_flush", "wp.search_replace", "wp.debug_on", "wp.debug_off", "wp.inventory", "wp.update"] as const;

export type DnsZoneData = { name: string; serial: number; records: { name: string; type: string; value: string; ttl: number; priority: number }[] };

/** `output` of a `workload.apm` job, JSON-encoded. Durations in milliseconds. */
export type ApmReport = {
  minutes: number;
  requests: number;
  avgMs: number;
  p95Ms: number;
  status: { ok: number; redirect: number; clientError: number; serverError: number };
  slowest: { path: string; count: number; avgMs: number; maxMs: number }[];
  busiest: { path: string; count: number; avgMs: number }[];
};

/** `output` of a `workload.files` job, JSON-encoded. */
export type FilesResult =
  | { kind: "list"; path: string; entries: { name: string; type: "dir" | "file" | "link"; size: number; mtime: number }[] }
  | { kind: "file"; path: string; content: string; truncated: boolean; binary: boolean }
  | { kind: "done"; path: string };

/** `output` of a `workload.db` job, JSON-encoded. Cells are strings; NULL is null. */
export type DbResult = { columns: string[]; rows: (string | null)[][]; truncated: boolean; message?: string };

/** `output` of the `wp.inventory` tool, JSON-encoded. */
export type WpInventory = {
  core: string;
  plugins: { name: string; title: string; status: string; version: string; update: string }[];
  themes: { name: string; title: string; status: string; version: string; update: string }[];
};
export type ToolName = (typeof TOOLS)[number];

export type JobResult = {
  runtime?: { internalHost?: string; dbName?: string; dbUser?: string; diskUsedMb?: number; version?: string };
  sizeBytes?: number;
  commitSha?: string;
  commitMessage?: string;
  /** For `workload.logs` and tools with output. */
  output?: string;
};

export type JobEnvelope<T extends JobType = JobType> = {
  v: typeof PROTOCOL_VERSION;
  id: string;
  nodeId: string;
  type: T;
  payload: JobPayloads[T];
  issuedAt: number;
  /** Epoch ms. Agents refuse to start a job after this instant. */
  expiresAt: number;
};

export type SignedJob = { envelope: JobEnvelope; signature: string };

export type PollRequest = {
  agentVersion: string;
  driver: string;
  stats: { cpuPercent?: number; memTotalMb?: number; memUsedMb?: number; diskTotalGb?: number; diskUsedGb?: number; workloads?: number };
  /** Per-workload resource usage, keyed by slug. */
  workloads?: { slug: string; cpuPercent: number; memMb: number; rxMb: number; txMb: number }[];
  /** How many more jobs the agent is willing to take right now. */
  capacity: number;
};
export type PollResponse = { jobs: SignedJob[]; pollIntervalMs: number };

export type JobReport =
  | { status: "running"; log: string }
  | { status: "succeeded"; log?: string; result: JobResult }
  | { status: "failed"; log?: string; error: string };

/**
 * Deterministic JSON: object keys sorted recursively, no whitespace. Both
 * sides sign / verify exactly these bytes, independent of key order.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}
