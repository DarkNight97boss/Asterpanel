import "server-only";
import { eq, ne } from "drizzle-orm";
import { getDb, schema } from "@/db";
import type { NodeStats } from "@/db/schema";
import { notify } from "./notify";
import { nodeIsOnline } from "@/platform/engine";

export const DISK_ALERT = 0.9;
export const MEMORY_ALERT = 0.95;

/** What is wrong with a server right now, as stable keys. */
export function nodeProblems(node: { status: string; lastSeenAt: Date | null; stats: NodeStats }): { key: string; text: string }[] {
  if (!node.lastSeenAt) return []; // never came online: that is setup, not an incident
  if (!nodeIsOnline(node)) return [{ key: "offline", text: "offline: the agent stopped reporting" }];
  const out: { key: string; text: string }[] = [];
  const pct = (used?: number, total?: number) => (used != null && total ? used / total : 0);
  const disk = pct(node.stats.diskUsedGb, node.stats.diskTotalGb);
  const mem = pct(node.stats.memUsedMb, node.stats.memTotalMb);
  if (disk >= DISK_ALERT) out.push({ key: "disk", text: `disk ${Math.round(disk * 100)}% full` });
  if (mem >= MEMORY_ALERT) out.push({ key: "memory", text: `memory ${Math.round(mem * 100)}% used` });
  return out;
}

/** Cron: tells staff about each new problem once, and once more when it is gone. */
export async function checkNodes(): Promise<{ raised: number; cleared: number }> {
  const db = await getDb();
  const report = { raised: 0, cleared: 0 };
  for (const node of await db.select().from(schema.nodes).where(ne(schema.nodes.status, "disabled"))) {
    const now = nodeProblems(node);
    const keys = now.map((p) => p.key);
    for (const p of now.filter((x) => !node.alerts.includes(x.key))) {
      notify.nodeAlert(node.name, p.text);
      report.raised++;
    }
    for (const gone of node.alerts.filter((k) => !keys.includes(k))) {
      notify.nodeAlert(node.name, `${gone}: back to normal`);
      report.cleared++;
    }
    if (keys.join() !== node.alerts.join()) await db.update(schema.nodes).set({ alerts: keys }).where(eq(schema.nodes.id, node.id));
  }
  return report;
}

/** Prometheus text exposition of what the panel knows: nodes, workloads, jobs, money owed. No customer names. */
export async function prometheusMetrics(): Promise<string> {
  const db = await getDb();
  const [nodes, workloads, jobs, invoices] = await Promise.all([db.select().from(schema.nodes), db.select({ status: schema.workloads.status, type: schema.workloads.type }).from(schema.workloads), db.select({ status: schema.jobs.status }).from(schema.jobs), db.select({ status: schema.invoices.status, total: schema.invoices.total }).from(schema.invoices).where(eq(schema.invoices.status, "unpaid"))]);
  const lines: string[] = [];
  const metric = (name: string, help: string, rows: [Record<string, string>, number][]) => {
    lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} gauge`);
    for (const [labels, value] of rows) lines.push(`${name}${Object.keys(labels).length ? `{${Object.entries(labels).map(([k, v]) => `${k}="${v.replace(/[\\"\n]/g, "_")}"`).join(",")}}` : ""} ${value}`);
  };
  const count = <T,>(list: T[], key: (x: T) => string) => [...Map.groupBy(list, key)].map(([k, v]) => [k, v.length] as const);
  metric("aster_node_up", "1 when the node's agent reported recently", nodes.map((n) => [{ node: n.name }, nodeIsOnline(n) ? 1 : 0]));
  metric("aster_node_cpu_percent", "CPU usage reported by the agent", nodes.map((n) => [{ node: n.name }, n.stats.cpuPercent ?? 0]));
  metric("aster_node_memory_used_ratio", "Used memory / total", nodes.map((n) => [{ node: n.name }, n.stats.memTotalMb ? (n.stats.memUsedMb ?? 0) / n.stats.memTotalMb : 0]));
  metric("aster_node_disk_used_ratio", "Used disk / total", nodes.map((n) => [{ node: n.name }, n.stats.diskTotalGb ? (n.stats.diskUsedGb ?? 0) / n.stats.diskTotalGb : 0]));
  metric("aster_workloads", "Workloads by type and status", count(workloads.filter((w) => w.status !== "deleted"), (w) => `${w.type}|${w.status}`).map(([k, n]) => [{ type: k.split("|")[0], status: k.split("|")[1] }, n]));
  metric("aster_jobs", "Jobs by status", count(jobs, (j) => j.status).map(([k, n]) => [{ status: k }, n]));
  metric("aster_unpaid_invoices", "Invoices waiting for payment", [[{}, invoices.length]]);
  metric("aster_unpaid_invoices_cents", "Total of unpaid invoices, in cents", [[{}, invoices.reduce((s, i) => s + i.total, 0)]]);
  return `${lines.join("\n")}\n`;
}
