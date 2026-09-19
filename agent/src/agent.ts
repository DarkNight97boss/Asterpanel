import { createPublicKey, verify, type KeyObject } from "node:crypto";
import os from "node:os";
import { statfs } from "node:fs/promises";
import { canonicalJson, PROTOCOL_VERSION, type JobEnvelope, type JobPayloads, type JobReport, type JobResult, type OffsiteTarget, type PollRequest, type PollResponse, type SignedJob, type ToolName, type WorkloadSpec } from "../../src/platform/protocol";
import type { Driver, Log } from "./driver";

export const AGENT_VERSION = "0.1.0";

/** How the agent talks to the control plane. HTTP in production, in-process in tests. */
export interface Transport {
  poll(request: PollRequest): Promise<PollResponse>;
  report(jobId: string, report: JobReport): Promise<void>;
}

export function httpTransport(baseUrl: string, token: string): Transport {
  const call = async (path: string, body: unknown) => {
    const res = await fetch(`${baseUrl.replace(/\/+$/, "")}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    // 409 = the control plane no longer wants this report; nothing to retry.
    if (!res.ok && res.status !== 409) throw new Error(`Control plane answered ${res.status} on ${path}`);
    return res;
  };
  return {
    poll: async (request) => (await call("/api/agent/v1/poll", request)).json() as Promise<PollResponse>,
    report: async (jobId, report) => void (await call(`/api/agent/v1/jobs/${jobId}`, report)),
  };
}

export const loadPublicKey = (base64Spki: string) => createPublicKey({ key: Buffer.from(base64Spki, "base64"), type: "spki", format: "der" });

export class Agent {
  private running = new Set<string>();
  private seen = new Set<string>();
  private stopped = false;

  constructor(
    private opts: { nodeId: string; publicKey: KeyObject; driver: Driver; transport: Transport; dataDir: string; maxParallel?: number; onError?: (e: unknown) => void },
  ) {}

  /** Why a job must not run, or null when it is genuine. */
  reject({ envelope, signature }: SignedJob): string | null {
    let valid = false;
    try {
      valid = verify(null, Buffer.from(canonicalJson(envelope)), this.opts.publicKey, Buffer.from(signature, "base64"));
    } catch {
      valid = false;
    }
    if (!valid) return "invalid signature";
    if (envelope.v !== PROTOCOL_VERSION) return `unsupported protocol version ${envelope.v}`;
    if (envelope.nodeId !== this.opts.nodeId) return "job addressed to another node";
    if (Date.now() > envelope.expiresAt) return "job expired";
    if (this.seen.has(envelope.id)) return "replayed job";
    return null;
  }

  private async stats(): Promise<PollRequest["stats"]> {
    const [load] = os.loadavg();
    const fs = await statfs(this.opts.dataDir).catch(() => null);
    const gb = (blocks: number) => Math.round(((blocks * (fs?.bsize ?? 0)) / 1e9) * 10) / 10;
    return {
      cpuPercent: Math.min(100, Math.round((load / os.cpus().length) * 100)),
      memTotalMb: Math.round(os.totalmem() / 1048576),
      memUsedMb: Math.round((os.totalmem() - os.freemem()) / 1048576),
      diskTotalGb: fs ? gb(fs.blocks) : undefined,
      diskUsedGb: fs ? gb(fs.blocks - fs.bfree) : undefined,
      workloads: await this.opts.driver.workloadCount().catch(() => undefined),
    };
  }

  /** One poll cycle. Returns the promises of the jobs it started. */
  async tick(): Promise<{ started: Promise<void>[]; pollIntervalMs: number }> {
    const capacity = (this.opts.maxParallel ?? 3) - this.running.size;
    const res = await this.opts.transport.poll({
      agentVersion: AGENT_VERSION,
      driver: this.opts.driver.name,
      stats: await this.stats(),
      workloads: await this.opts.driver.workloadStats().catch(() => []),
      capacity: Math.max(capacity, 0),
    });
    const started: Promise<void>[] = [];
    for (const job of res.jobs ?? []) {
      const why = this.reject(job);
      if (why) {
        // Never execute, and say so loudly: this is either a bug or an attack.
        this.opts.onError?.(new Error(`Refused job ${job.envelope?.id}: ${why}`));
        if (job.envelope?.id && why !== "invalid signature") await this.opts.transport.report(job.envelope.id, { status: "failed", error: `Refused by agent: ${why}` }).catch(() => {});
        continue;
      }
      this.seen.add(job.envelope.id);
      started.push(this.execute(job.envelope));
    }
    return { started, pollIntervalMs: res.pollIntervalMs || 3000 };
  }

  private async execute(envelope: JobEnvelope) {
    this.running.add(envelope.id);
    let buffer = "";
    const flush = async () => {
      if (!buffer) return;
      const log = buffer;
      buffer = "";
      await this.opts.transport.report(envelope.id, { status: "running", log }).catch(() => (buffer = log + buffer));
    };
    const timer = setInterval(flush, 1500);
    const log: Log = (line) => (buffer += `${line.replace(/\s+$/, "")}\n`);

    let report: JobReport;
    try {
      report = { status: "succeeded", result: await this.dispatch(envelope, log) };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      log(`ERROR: ${error}`);
      report = { status: "failed", error };
    } finally {
      clearInterval(timer);
    }
    report.log = buffer;
    // The outcome matters more than anything else the agent sends: retry it.
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        await this.opts.transport.report(envelope.id, report);
        break;
      } catch (err) {
        this.opts.onError?.(err);
        await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
      }
    }
    this.running.delete(envelope.id);
  }

  private dispatch(envelope: JobEnvelope, log: Log): Promise<JobResult> {
    const d = this.opts.driver;
    // The signature covers type + payload together, so the shape matches the type.
    const p = envelope.payload as { spec: WorkloadSpec; from: WorkloadSpec; lines: number; tool: ToolName; args?: Record<string, string>; backupId: string; offsite?: OffsiteTarget; action: "tables" | "query"; sql?: string; path?: string; content?: string; fileAction: JobPayloads["workload.files"]["action"] };
    if (envelope.type === "workload.files") p.fileAction = (envelope.payload as JobPayloads["workload.files"]).action;
    switch (envelope.type) {
      case "workload.create":
        return d.create(p.spec, log);
      case "workload.update":
        return d.update(p.spec, log);
      case "workload.start":
        return d.start(p.spec, log);
      case "workload.stop":
        return d.stop(p.spec, log);
      case "workload.restart":
        return d.stop(p.spec, log).then(() => d.start(p.spec, log));
      case "workload.delete":
        return d.remove(p.spec, log);
      case "workload.clone":
        return d.clone(p.spec, p.from, log);
      case "workload.deploy":
        return d.deploy(p.spec, log, envelope.payload as JobPayloads["workload.deploy"]);
      case "workload.logs":
        return d.logs(p.spec, p.lines);
      case "workload.tool":
        return d.tool(p.spec, p.tool, p.args ?? {}, log);
      case "workload.apm":
        return d.apm(p.spec, (envelope.payload as JobPayloads["workload.apm"]).minutes);
      case "workload.files":
        return d.files(p.spec, p.fileAction, p.path ?? "", p.content, log, (envelope.payload as JobPayloads["workload.files"]).encoding);
      case "workload.migrate": {
        const m = envelope.payload as JobPayloads["workload.migrate"];
        return d.migrate(m.spec, m.source, m.newUrl, log);
      }
      case "dns.sync":
        return d.dnsSync(envelope.payload as JobPayloads["dns.sync"], log);
      case "workload.db":
        return d.db(p.spec, p.action, p.sql ?? "", log);
      case "backup.create":
        return d.backupCreate(p.spec, p.backupId, log, p.offsite);
      case "backup.restore":
        return d.backupRestore(p.spec, p.backupId, log, p.offsite);
      case "backup.delete":
        return d.backupDelete(p.spec, p.backupId, log, p.offsite);
      case "offsite.test":
        return d.offsiteTest((envelope.payload as JobPayloads["offsite.test"]).offsite, log);
      default:
        return Promise.reject(new Error(`Unknown job type ${String(envelope.type)}`));
    }
  }

  private lastCronMinute = -1;

  /** At most once per wall-clock minute, whatever the polling interval is. */
  async cronTick(now = new Date()): Promise<string[]> {
    const minute = Math.floor(now.getTime() / 60_000);
    if (minute === this.lastCronMinute) return [];
    this.lastCronMinute = minute;
    return this.opts.driver.runDueCrons(now).catch((err) => {
      this.opts.onError?.(err);
      return [];
    });
  }

  async run() {
    let delay = 3000;
    while (!this.stopped) {
      void this.cronTick();
      try {
        delay = (await this.tick()).pollIntervalMs;
      } catch (err) {
        this.opts.onError?.(err);
        delay = Math.min(delay * 2, 60_000); // back off while the control plane is unreachable
      }
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  stop() {
    this.stopped = true;
  }
}
