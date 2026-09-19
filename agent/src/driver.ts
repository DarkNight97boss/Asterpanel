import type { JobPayloads, JobResult, OffsiteTarget, ToolName, WorkloadSpec } from "../../src/platform/protocol";

export type Log = (line: string) => void;

/**
 * What a node can do. `docker.ts` is the production implementation;
 * `simulated.ts` fakes it for development machines without a container runtime.
 * Every method must be idempotent: the control plane may retry.
 */
export interface Driver {
  readonly name: string;
  create(spec: WorkloadSpec, log: Log): Promise<JobResult>;
  update(spec: WorkloadSpec, log: Log): Promise<JobResult>;
  start(spec: WorkloadSpec, log: Log): Promise<JobResult>;
  stop(spec: WorkloadSpec, log: Log): Promise<JobResult>;
  remove(spec: WorkloadSpec, log: Log): Promise<JobResult>;
  clone(spec: WorkloadSpec, from: WorkloadSpec, log: Log): Promise<JobResult>;
  deploy(spec: WorkloadSpec, log: Log): Promise<JobResult>;
  logs(spec: WorkloadSpec, lines: number): Promise<JobResult>;
  tool(spec: WorkloadSpec, tool: ToolName, args: Record<string, string>, log: Log): Promise<JobResult>;
  db(spec: WorkloadSpec, action: "tables" | "query", sql: string, log: Log): Promise<JobResult>;
  apm(spec: WorkloadSpec, minutes: number): Promise<JobResult>;
  files(spec: WorkloadSpec, action: JobPayloads["workload.files"]["action"], path: string, content: string | undefined, log: Log, encoding?: "utf8" | "base64"): Promise<JobResult>;
  dnsSync(data: JobPayloads["dns.sync"], log: Log): Promise<JobResult>;
  backupCreate(spec: WorkloadSpec, backupId: string, log: Log, offsite?: OffsiteTarget): Promise<JobResult>;
  backupRestore(spec: WorkloadSpec, backupId: string, log: Log, offsite?: OffsiteTarget): Promise<JobResult>;
  backupDelete(spec: WorkloadSpec, backupId: string, log: Log, offsite?: OffsiteTarget): Promise<JobResult>;
  offsiteTest(offsite: OffsiteTarget, log: Log): Promise<JobResult>;
  workloadCount(): Promise<number>;
  /** Resource usage per workload slug, for analytics. */
  workloadStats(): Promise<{ slug: string; cpuPercent: number; memMb: number; rxMb: number; txMb: number }[]>;
}
