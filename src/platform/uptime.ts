import "server-only";
import { and, desc, eq, inArray, lt } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { notify } from "@/lib/notify";

const KEEP_MS = 7 * 86_400_000;

/**
 * Availability probe of every running web workload, from the control plane —
 * i.e. from outside the node, the way a visitor arrives. Two failures in a row
 * make an incident (one blip does not wake anybody up); the first success
 * afterwards closes it. Workloads on simulated nodes are skipped.
 */
export async function runUptimeChecks(now = new Date(), probe: (url: string) => Promise<{ status: number; ms: number; error?: string }> = httpProbe) {
  const db = await getDb();
  const targets = await db.query.workloads.findMany({
    where: and(eq(schema.workloads.status, "running"), eq(schema.workloads.environment, "live"), inArray(schema.workloads.type, ["wordpress", "app", "static"])),
    with: { domains: true, node: { columns: { driver: true } } },
  });
  let checked = 0;
  let incidents = 0;

  await Promise.all(
    targets.map(async (w) => {
      const host = (w.domains.find((d) => d.isPrimary) ?? w.domains[0])?.hostname;
      if (!host || w.node.driver === "simulated") return;
      const result = await probe(`https://${host}/`);
      const ok = !result.error && result.status > 0 && result.status < 500;
      const previous = await db.select().from(schema.uptimeChecks).where(eq(schema.uptimeChecks.workloadId, w.id)).orderBy(desc(schema.uptimeChecks.at)).limit(2);
      await db.insert(schema.uptimeChecks).values({ workloadId: w.id, at: now, ok, status: result.status, ms: result.ms, error: (result.error ?? "").slice(0, 200) });
      checked++;

      const wasDown = previous.length >= 2 && !previous[0].ok && !previous[1].ok;
      if (!ok && previous[0] && !previous[0].ok && !wasDown) {
        incidents++;
        notify.uptime(w.id, "down", result.error || `HTTP ${result.status}`);
      } else if (ok && wasDown) {
        notify.uptime(w.id, "up", "");
      }
    }),
  );
  await db.delete(schema.uptimeChecks).where(lt(schema.uptimeChecks.at, new Date(now.getTime() - KEEP_MS)));
  return { checked, incidents };
}

async function httpProbe(url: string) {
  const started = Date.now();
  try {
    const res = await fetch(url, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(10_000), headers: { "User-Agent": "AsterUptime/1.0" }, cache: "no-store" });
    await res.body?.cancel();
    return { status: res.status, ms: Date.now() - started };
  } catch (err) {
    return { status: 0, ms: Date.now() - started, error: err instanceof Error ? (err.cause instanceof Error ? err.cause.message : err.message) : "request failed" };
  }
}

/** Availability over the kept window plus the latest checks, for the dashboard. */
export async function uptimeSummary(workloadId: string) {
  const db = await getDb();
  const checks = await db.select().from(schema.uptimeChecks).where(eq(schema.uptimeChecks.workloadId, workloadId)).orderBy(desc(schema.uptimeChecks.at)).limit(3000);
  const up = checks.filter((c) => c.ok);
  return {
    checks: checks.length,
    percent: checks.length ? Math.round((up.length / checks.length) * 10_000) / 100 : null,
    avgMs: up.length ? Math.round(up.reduce((n, c) => n + c.ms, 0) / up.length) : null,
    last: checks[0] ?? null,
    recentFailures: checks.filter((c) => !c.ok).slice(0, 5),
  };
}
