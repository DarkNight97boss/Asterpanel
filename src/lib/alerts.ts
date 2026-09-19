import "server-only";
import { and, desc, eq, gte, inArray } from "drizzle-orm";
import { getDb, schema } from "@/db";
import type { AccountRole } from "./roles";
import { roleCan } from "./roles";

export type AccountAlert = { kind: "ticket" | "invoice" | "workload" | "job"; text: string; vars?: Record<string, string>; href: string; at: Date };

const WEEK = 7 * 86_400_000;

/**
 * What needs the account's attention right now. There is no "read" flag on
 * purpose: an item disappears when it is dealt with (invoice paid, ticket
 * answered back, service healthy), so the bell never nags about old news.
 */
export async function accountAlerts(accountId: string, role: AccountRole, now = new Date(), only: string[] | null = null): Promise<AccountAlert[]> {
  const db = await getDb();
  const alerts: AccountAlert[] = [];

  const tickets = await db.select().from(schema.tickets).where(and(eq(schema.tickets.companyId, accountId), eq(schema.tickets.status, "answered")));
  for (const tk of tickets) alerts.push({ kind: "ticket", text: "Support replied: {subject}", vars: { subject: tk.subject }, href: `/client/tickets/${tk.id}`, at: tk.lastReplyAt });

  if (roleCan(role, "billing")) {
    const unpaid = await db.select().from(schema.invoices).where(and(eq(schema.invoices.companyId, accountId), eq(schema.invoices.status, "unpaid")));
    for (const inv of unpaid) {
      alerts.push({ kind: "invoice", text: inv.dueDate < now ? "Invoice #{n} is overdue" : "Invoice #{n} is waiting for payment", vars: { n: String(inv.number) }, href: `/client/invoices/${inv.id}`, at: inv.createdAt });
    }
  }

  if (roleCan(role, "hosting")) {
    const mine = (await db.select({ id: schema.workloads.id, name: schema.workloads.name, status: schema.workloads.status, updatedAt: schema.workloads.updatedAt, config: schema.workloads.config }).from(schema.workloads).where(eq(schema.workloads.companyId, accountId))).filter((w) => !only || only.includes(w.id));
    for (const w of mine) {
      if (w.status === "error") alerts.push({ kind: "workload", text: "{name} needs attention", vars: { name: w.name }, href: `/client/workloads/${w.id}`, at: w.updatedAt });
      if (w.status !== "deleted" && (w.config.scanFindings ?? 0) > 0) alerts.push({ kind: "workload", text: "Security scan: {n} findings on {name}", vars: { name: w.name, n: String(w.config.scanFindings) }, href: `/client/workloads/${w.id}/security`, at: new Date(w.config.scanLastAt ?? w.updatedAt) });
      if (w.status === "suspended") alerts.push({ kind: "workload", text: "{name} is suspended", vars: { name: w.name }, href: `/client/workloads/${w.id}`, at: w.updatedAt });
    }
    const live = mine.filter((w) => w.status !== "deleted");
    if (live.length) {
      const failed = await db
        .select()
        .from(schema.jobs)
        .where(and(inArray(schema.jobs.workloadId, live.map((w) => w.id)), eq(schema.jobs.status, "failed"), gte(schema.jobs.createdAt, new Date(now.getTime() - WEEK))))
        .orderBy(desc(schema.jobs.createdAt))
        .limit(10);
      const names = new Map(live.map((w) => [w.id, w.name]));
      for (const j of failed) alerts.push({ kind: "job", text: "An operation failed on {name}", vars: { name: names.get(j.workloadId ?? "") ?? "" }, href: `/client/workloads/${j.workloadId}/activity`, at: j.createdAt });
    }
  }
  return alerts.sort((a, b) => b.at.getTime() - a.at.getTime());
}
