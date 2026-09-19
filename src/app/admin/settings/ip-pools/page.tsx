import { ActionForm, SubmitButton } from "@/components/action-form";
import { Badge, Button, ButtonLink, Card, CardHeader, Checkbox, EmptyState, Field, Input, PageHeader, Select, Table, Td } from "@/components/ui";
import { getLocale, getT } from "@/i18n";
import { requireAdmin } from "@/lib/auth";
import { formatDateTime } from "@/lib/format";
import { poolUsage } from "@/lib/ip-pools";
import { cloudProviders } from "@/modules/cloud";
import { newPool, releaseIp, removePool, togglePool } from "./actions";

export const metadata = { title: "IP address pools" };

export default async function IpPools() {
  await requireAdmin();
  const [t, locale, pools] = await Promise.all([getT(), getLocale(), poolUsage()]);
  const capable = cloudProviders.filter((p) => p.reserveIp);

  return (
    <>
      <PageHeader title={t("IP address pools")} description={t("The public addresses your servers use. New cloud servers lease one by themselves; when a server is deleted its address goes back to the pool and is the first to be used again.")} action={<ButtonLink href="/admin/settings/cloud" variant="secondary">{t("Infrastructure")}</ButtonLink>} />
      <div className="space-y-6">
        {pools.length ? pools.map(({ pool, leases, inUse, capacity }) => (
          <Card key={pool.id}>
            <CardHeader
              title={<span className="flex flex-wrap items-center gap-3">{pool.name} {pool.autoLease ? <Badge tone="success">{t("Automatic lease")}</Badge> : <Badge>{t("Paused")}</Badge>}</span>}
              description={`${cloudProviders.find((p) => p.id === pool.provider)?.name ?? pool.provider} · ${pool.region} · ${pool.mode === "block" ? `${t("own block")} ${pool.cidr}` : t("addresses reserved at the provider")} · ${t("{used} in use of {total}", { used: inUse, total: capacity ?? leases.length })}`}
              action={
                <div className="flex gap-1">
                  <form action={togglePool}><input type="hidden" name="id" value={pool.id} /><Button size="sm" variant="ghost">{pool.autoLease ? t("Pause") : t("Resume")}</Button></form>
                  <ActionForm action={removePool} className=""><input type="hidden" name="id" value={pool.id} /><SubmitButton size="sm" variant="ghost">{t("Remove")}</SubmitButton></ActionForm>
                </div>
              }
            />
            {leases.length > 0 && (
              <Table head={[t("Address"), t("Server"), t("Leased"), ""]}>
                {leases.map(({ lease, node }) => (
                  <tr key={lease.id}>
                    <Td><code className="font-mono text-sm">{lease.address}</code></Td>
                    <Td className="text-body">{node ?? <span className="text-muted">{t("free, kept reserved")}</span>}</Td>
                    <Td className="text-body">{lease.nodeId && lease.leasedAt ? formatDateTime(lease.leasedAt, locale) : "—"}</Td>
                    <Td className="text-right">{!lease.nodeId && <ActionForm action={releaseIp} className=""><input type="hidden" name="id" value={lease.id} /><SubmitButton size="sm" variant="ghost">{t("Give back to the provider")}</SubmitButton></ActionForm>}</Td>
                  </tr>
                ))}
              </Table>
            )}
          </Card>
        )) : <Card><EmptyState title={t("No pools")} description={t("Without a pool, each new server simply gets whatever address the provider assigns.")} /></Card>}

        <Card>
          <CardHeader title={t("New pool")} description={t("Own block: a range your company owns and has already brought to the provider (on Google Cloud, a BYOIP public delegated prefix in that region). Reserved: the provider picks the addresses, the panel keeps them so rebuilt servers return on the same one.")} />
          <div className="p-5">
            <ActionForm action={newPool}>
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
                <Field label={t("Name")}><Input name="name" required maxLength={60} placeholder="Milan production" /></Field>
                <Field label={t("Provider")}><Select name="provider">{capable.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select></Field>
                <Field label={t("Region")} hint="europe-west8 · fsn1"><Input name="region" required /></Field>
                <Field label={t("Kind")}><Select name="mode" defaultValue="reserved"><option value="reserved">{t("Reserved at the provider")}</option><option value="block">{t("Own block (Google Cloud)")}</option></Select></Field>
                <Field label={t("Block (CIDR)")} hint={t("Only for an own block")}><Input name="cidr" placeholder="203.0.113.0/28" /></Field>
              </div>
              <Checkbox name="autoLease" defaultChecked label={t("Lease an address to every new server of this provider and region")} />
              <SubmitButton>{t("Create pool")}</SubmitButton>
            </ActionForm>
          </div>
        </Card>
      </div>
    </>
  );
}
