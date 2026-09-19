import Link from "next/link";
import { and, asc, count, eq, ne } from "drizzle-orm";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { AutoRefresh } from "@/components/auto-refresh";
import { Badge, Card, CardHeader, EmptyState, Field, Input, PageHeader, Table, Td, Checkbox } from "@/components/ui";
import { getDb, schema } from "@/db";
import { getLocale, getT } from "@/i18n";
import { requireAdmin } from "@/lib/auth";
import { formatDateTime } from "@/lib/format";
import { nodeIsOnline } from "@/platform/engine";
import { enabledCloudProviders, syncCloudNodes } from "@/lib/cloud";
import { rateLimit } from "@/lib/rate-limit";
import { createCloudServer, createNode } from "../platform-actions";

export default async function Nodes() {
  await requireAdmin();
  const db = await getDb();
  // This page refreshes every few seconds; providers are asked for new addresses at most twice a minute.
  if (rateLimit("cloud-sync", 1, 30_000)) await syncCloudNodes().catch(() => {});
  const clouds = await enabledCloudProviders();
  const [t, locale, rows] = await Promise.all([
    getT(),
    getLocale(),
    db
      .select({ node: schema.nodes, workloads: count(schema.workloads.id) })
      .from(schema.nodes)
      .leftJoin(schema.workloads, and(eq(schema.workloads.nodeId, schema.nodes.id), ne(schema.workloads.status, "deleted")))
      .groupBy(schema.nodes.id)
      .orderBy(asc(schema.nodes.name)),
  ]);

  return (
    <>
      <AutoRefresh active intervalMs={5000} />
      <PageHeader title={t("Nodes")} description={t("Your servers. Each one runs the Aster agent and hosts customer workloads in isolated containers.")} />
      <Card className="mb-6">
        {rows.length ? (
          <Table head={[t("Node"), t("Region"), t("Status"), t("Load"), t("Workloads"), t("Agent"), t("Last seen")]}>
            {rows.map(({ node: n, workloads }) => {
              const online = nodeIsOnline(n);
              const pct = (used?: number, total?: number) => (used != null && total ? `${Math.round((used / total) * 100)}%` : "—");
              return (
                <tr key={n.id}>
                  <Td>
                    <Link href={`/admin/nodes/${n.id}`} className="font-medium hover:text-link">{n.name}</Link>
                    <span className="block font-mono text-xs text-muted">*.{n.baseDomain || "—"}</span>
                    <span className="block text-xs text-muted">{n.provider ? `${n.provider} · ${n.providerSize} · ${n.publicIp || t("address pending")}` : t("Own server")}</span>
                  </Td>
                  <Td>{n.region || "—"}</Td>
                  <Td>
                    {n.status === "disabled" ? <Badge>{t("Disabled")}</Badge> : online ? <Badge tone="success">{t("Online")}</Badge> : n.lastSeenAt ? <Badge tone="danger">{t("Offline")}</Badge> : <Badge tone="warning">{t("Waiting for agent")}</Badge>}
                  </Td>
                  <Td className="text-xs text-muted">
                    CPU {n.stats.cpuPercent ?? "—"}% · RAM {pct(n.stats.memUsedMb, n.stats.memTotalMb)} · {t("Disk")} {pct(n.stats.diskUsedGb, n.stats.diskTotalGb)}
                  </Td>
                  <Td>{workloads}{n.maxWorkloads > 0 && ` / ${n.maxWorkloads}`}</Td>
                  <Td className="text-xs text-muted">{n.agentVersion ? `${n.agentVersion} · ${n.driver}` : "—"}</Td>
                  <Td className="text-xs text-muted">{formatDateTime(n.lastSeenAt, locale)}</Td>
                </tr>
              );
            })}
          </Table>
        ) : (
          <EmptyState title={t("No nodes yet")} description={t("Add your first server below, then run the install command on it.")} />
        )}
      </Card>

      <Card>
        <CardHeader title={t("Add your own server")} description={t("Physical or any other server you manage: run the install command on it. A wildcard DNS record *.<base domain> must point at the server: every site gets a free hostname under it.")} />
        <div className="p-5">
          <ActionForm action={createNode}>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
              <Field label={t("Name")}><Input name="name" placeholder="fsn1-node-01" required /></Field>
              <Field label={t("Region")}><Input name="region" placeholder="eu-central" /></Field>
              <Field label={t("Base domain")}><Input name="baseDomain" placeholder="n1.example.cloud" /></Field>
              <Field label={t("Public IP")}><Input name="publicIp" placeholder="203.0.113.10" /></Field>
              <Field label={t("Max workloads")} hint={t("0 = unlimited")}><Input name="maxWorkloads" type="number" min={0} defaultValue={0} /></Field>
            </div>
            <SubmitButton>{t("Add node")}</SubmitButton>
          </ActionForm>
        </div>
      </Card>

      {clouds.length > 0 ? clouds.map((p) => (
        <Card key={p.id}>
          <CardHeader title={t("New server on {provider}", { provider: p.name })} description={t("The panel creates an Ubuntu 24.04 machine that installs Docker and the agent by itself. Point *.<base domain> at its address once it appears in the list.")} />
          <div className="p-5">
            <ActionForm action={createCloudServer}>
              <input type="hidden" name="provider" value={p.id} />
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
                <Field label={t("Name")}><Input name="name" placeholder={`${p.id}-node-01`} required pattern="[a-z][a-z0-9-]*" /></Field>
                <Field label={t("Region")}><Input name="region" list={`${p.id}-regions`} required placeholder={p.regions[0]?.id} /><datalist id={`${p.id}-regions`}>{p.regions.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}</datalist></Field>
                <Field label={t("Size")}><Input name="size" list={`${p.id}-sizes`} required placeholder={p.sizes[0]?.id} /><datalist id={`${p.id}-sizes`}>{p.sizes.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}</datalist></Field>
                <Field label={t("Base domain")}><Input name="baseDomain" placeholder="n2.example.cloud" /></Field>
                <Field label={t("Max workloads")} hint={t("0 = unlimited")}><Input name="maxWorkloads" type="number" min={0} defaultValue={0} /></Field>
              </div>
              <Checkbox name="confirm" label={t("I understand that {provider} starts billing this server as soon as it is created", { provider: p.name })} />
              <SubmitButton>{t("Create server")}</SubmitButton>
            </ActionForm>
          </div>
        </Card>
      )) : (
        <p className="text-sm text-muted">{t("Want the panel to create servers for you?")} <Link href="/admin/settings/cloud" className="text-link">{t("Enable a cloud provider")} →</Link></p>
      )}
    </>
  );
}
