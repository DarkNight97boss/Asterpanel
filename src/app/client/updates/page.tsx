import Link from "next/link";
import { and, desc, eq, inArray } from "drizzle-orm";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { AutoRefresh } from "@/components/auto-refresh";
import { Card, CardHeader, EmptyState, PageHeader, Table, Td } from "@/components/ui";
import { getDb, schema } from "@/db";
import { getT } from "@/i18n";
import { mayAccess, requireAccount } from "@/lib/account";
import type { WpInventory } from "@/platform/protocol";
import { bulkScan, bulkUpdate } from "./actions";

export const metadata = { title: "WordPress updates" };

type Row = { kind: "plugin" | "theme" | "core"; name: string; title: string; to: string; sites: { id: string; name: string; from: string }[] };

export default async function Updates() {
  const { account, can } = await requireAccount("hosting");
  const db = await getDb();
  const t = await getT();
  const sites = (await db.select().from(schema.workloads).where(and(eq(schema.workloads.companyId, account.id), eq(schema.workloads.type, "wordpress"), eq(schema.workloads.environment, "live"), eq(schema.workloads.status, "running")))).filter((w) => mayAccess(account, w));
  const jobs = sites.length ? await db.select().from(schema.jobs).where(and(inArray(schema.jobs.workloadId, sites.map((s) => s.id)), eq(schema.jobs.type, "workload.tool"))).orderBy(desc(schema.jobs.createdAt)).limit(sites.length * 15) : [];
  const busy = jobs.some((j) => j.status === "queued" || j.status === "running");

  // Newest inventory per site.
  const rows = new Map<string, Row>();
  let scanned = 0;
  for (const site of sites) {
    const job = jobs.find((j) => j.workloadId === site.id && j.status === "succeeded" && String(j.result.output ?? "").startsWith('{"core"'));
    if (!job) continue;
    scanned++;
    const inv = JSON.parse(String(job.result.output)) as WpInventory;
    for (const kind of ["plugin", "theme"] as const) {
      for (const item of kind === "plugin" ? inv.plugins : inv.themes) {
        if (!item.update) continue;
        const key = `${kind}:${item.name}`;
        const row = rows.get(key) ?? { kind, name: item.name, title: item.title, to: item.update, sites: [] };
        row.sites.push({ id: site.id, name: site.name, from: item.version });
        rows.set(key, row);
      }
    }
  }
  const list = [...rows.values()].sort((a, b) => b.sites.length - a.sites.length || a.title.localeCompare(b.title));
  const manage = can("manage");

  return (
    <>
      <AutoRefresh active={busy} />
      <PageHeader
        title={t("WordPress updates")}
        description={t("Plugins and themes with a newer version, across the {n} running sites of {account}.", { n: sites.length, account: account.name })}
        action={sites.length > 0 && <ActionForm action={bulkScan} className=""><SubmitButton variant="secondary" disabled={busy}>{busy ? t("Working…") : t("Scan all sites")}</SubmitButton></ActionForm>}
      />
      <Card>
        {scanned < sites.length && <p className="border-b border-border px-5 py-3 text-sm text-muted">{t("{n} sites have not been scanned yet: press “Scan all sites”.", { n: sites.length - scanned })}</p>}
        {list.length ? (
          <>
            <CardHeader title={t("{n} updates available", { n: list.length })} action={manage && <ActionForm action={bulkUpdate} className=""><input type="hidden" name="all" value="1" /><SubmitButton disabled={busy}>{t("Update everything")}</SubmitButton></ActionForm>} />
            <Table head={[t("Name"), t("Type"), t("New version"), t("Sites"), ""]}>
              {list.map((r) => (
                <tr key={`${r.kind}:${r.name}`}>
                  <Td><span className="font-medium">{r.title}</span><span className="block font-mono text-xs text-muted">{r.name}</span></Td>
                  <Td className="text-body">{t(r.kind === "plugin" ? "Plugin" : "Theme")}</Td>
                  <Td>{r.to}</Td>
                  <Td className="text-sm">{r.sites.map((s, i) => <span key={s.id}>{i > 0 && ", "}<Link href={`/client/workloads/${s.id}/plugins`} className="text-link">{s.name}</Link> <span className="text-xs text-muted">({s.from})</span></span>)}</Td>
                  <Td className="text-right">
                    {manage && (
                      <ActionForm action={bulkUpdate} className="">
                        <input type="hidden" name="kind" value={r.kind} />
                        <input type="hidden" name="name" value={r.name} />
                        {r.sites.map((s) => <input key={s.id} type="hidden" name="site" value={s.id} />)}
                        <SubmitButton size="sm" variant="ghost" disabled={busy}>{t("Update on {n} sites", { n: r.sites.length })}</SubmitButton>
                      </ActionForm>
                    )}
                  </Td>
                </tr>
              ))}
            </Table>
          </>
        ) : (
          <EmptyState title={scanned ? t("Everything is up to date") : t("Nothing here yet")} />
        )}
      </Card>
    </>
  );
}
