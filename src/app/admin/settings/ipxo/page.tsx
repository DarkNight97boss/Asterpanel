import { ActionForm, SubmitButton } from "@/components/action-form";
import { Alert, Badge, Button, ButtonLink, Card, CardHeader, Checkbox, EmptyState, Field, Input, PageHeader, Select, Table, Td } from "@/components/ui";
import { getLocale, getT } from "@/i18n";
import { requireAdmin } from "@/lib/auth";
import { formatDate, formatMoney } from "@/lib/format";
import { OWN_SERVERS } from "@/lib/ip-pools";
import { IpxoError, listIpBlocks, searchMarket, type MarketBlock } from "@/lib/ipxo";
import { getSettings } from "@/lib/settings";
import { askLoa, makePool, order, saveIpxo, syncNow, testConnection } from "./actions";

export const metadata = { title: "IP leasing (IPXO)" };

export default async function Ipxo({ searchParams }: { searchParams: Promise<{ prefix?: string; country?: string }> }) {
  await requireAdmin();
  const [t, locale, s, blocks, query] = await Promise.all([getT(), getLocale(), getSettings("ipxo"), listIpBlocks(), searchParams]);
  const kept = (v: string) => (v ? "••••••••  (unchanged)" : "");
  let market: MarketBlock[] = [];
  let marketError = "";
  if (s.enabled && query.prefix) {
    try {
      market = await searchMarket({ prefixLength: Number(query.prefix), country: query.country });
    } catch (err) {
      if (!(err instanceof IpxoError)) throw err;
      marketError = err.message;
    }
  }

  return (
    <>
      <PageHeader title={t("IP leasing (IPXO)")} description={t("Lease IPv4 blocks on the IPXO marketplace with your own account, ask for the letter of authorisation, and hand the addresses out from a pool.")} action={<ButtonLink href="/admin/settings/ip-pools" variant="secondary">{t("IP address pools")}</ButtonLink>} />
      <div className="space-y-6">
        <Card>
          <CardHeader title={t("IPXO account")} description={t("In the IPXO portal create an app key with access to the billing API. The secret is encrypted at rest and never shown again.")} />
          <div className="p-5">
            <ActionForm action={saveIpxo}>
              <Checkbox name="enabled" defaultChecked={s.enabled} label={t("Use IPXO")} />
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                <Field label="Client ID"><Input name="clientId" defaultValue={s.clientId} autoComplete="off" /></Field>
                <Field label="Client secret"><Input name="clientSecret" type="password" autoComplete="off" placeholder={kept(s.clientSecret)} /></Field>
                <Field label="Tenant UUID"><Input name="tenantUuid" defaultValue={s.tenantUuid} autoComplete="off" /></Field>
                <Field label={t("Scopes")} hint={t("As granted to the app key, separated by spaces.")}><Input name="scopes" defaultValue={s.scopes} /></Field>
                <Field label={t("AS number")} hint={t("The network that announces the blocks: yours, or your provider's for BYOIP.")}><Input name="asn" defaultValue={s.asn} placeholder="64500" inputMode="numeric" /></Field>
                <Field label={t("Company name on the LOA")}><Input name="companyName" defaultValue={s.companyName} maxLength={120} /></Field>
              </div>
              <SubmitButton>{t("Save")}</SubmitButton>
            </ActionForm>
            {s.enabled && <ActionForm action={testConnection} className="mt-3"><SubmitButton size="sm" variant="secondary">{t("Test the connection")}</SubmitButton></ActionForm>}
          </div>
        </Card>

        <Card>
          <CardHeader title={t("Leased blocks")} description={t("Checked every day: when a lease ends, its pool stops handing out addresses.")} action={s.enabled && <ActionForm action={syncNow} className=""><SubmitButton size="sm" variant="ghost">{t("Update now")}</SubmitButton></ActionForm>} />
          {blocks.length ? (
            <Table head={[t("Block"), t("Status"), t("Renews"), "LOA", t("Pool")]}>
              {blocks.map(({ block, pool }) => (
                <tr key={block.id}>
                  <Td><code className="font-mono text-sm">{block.cidr}</code></Td>
                  <Td>{block.status === "active" ? <Badge tone="success">{t("Active")}</Badge> : <Badge tone="danger">{t("Ended")}</Badge>}</Td>
                  <Td className="text-body">{block.renewsAt ? formatDate(block.renewsAt, locale) : "—"}</Td>
                  <Td>
                    {block.loaStatus === "active" ? <Badge tone="success">AS{block.asn ?? ""}</Badge> : block.loaStatus === "requested" ? <Badge>{t("Requested")}</Badge> : block.status === "active" ? (
                      <ActionForm action={askLoa} className=""><input type="hidden" name="id" value={block.id} /><SubmitButton size="sm" variant="ghost">{t("Request for AS{asn}", { asn: s.asn || "…" })}</SubmitButton></ActionForm>
                    ) : "—"}
                  </Td>
                  <Td>
                    {pool ?? (block.status === "active" ? (
                      <ActionForm action={makePool} className="flex flex-wrap items-center gap-2">
                        <input type="hidden" name="id" value={block.id} />
                        <Select name="provider" className="w-auto"><option value="gcp">Google Cloud</option><option value={OWN_SERVERS}>{t("Own servers")}</option></Select>
                        <Input name="region" required placeholder="europe-west8 · milan-dc1" className="w-44" />
                        <SubmitButton size="sm" variant="secondary">{t("Create pool")}</SubmitButton>
                      </ActionForm>
                    ) : "—")}
                  </Td>
                </tr>
              ))}
            </Table>
          ) : <EmptyState title={t("No leased blocks")} description={t("Blocks leased with this IPXO account appear here by themselves.")} />}
          <p className="border-t border-border p-5 text-xs text-muted">{t("A leased block works only where somebody announces it. On Google Cloud bring it first as BYOIP (public advertised prefix, then a delegated prefix in the region); on your own servers your upstream announces it with the LOA. Hetzner and the AWS integration here cannot use it.")}</p>
        </Card>

        {s.enabled && (
          <Card>
            <CardHeader title={t("Marketplace")} description={t("Prices are IPXO's, per month, charged to the payment method of your IPXO account.")} />
            <div className="p-5">
              <form method="get" className="flex flex-wrap items-end gap-3">
                <Field label={t("Size")}><Select name="prefix" defaultValue={query.prefix ?? "24"}>{[24, 23, 22, 21, 20].map((p) => <option key={p} value={p}>/{p} · {2 ** (32 - p)}</option>)}</Select></Field>
                <Field label={t("Country")} hint="IT · DE · US"><Input name="country" defaultValue={query.country ?? ""} maxLength={2} className="w-24 uppercase" /></Field>
                <Button variant="secondary">{t("Search")}</Button>
              </form>
              {marketError && <div className="mt-4"><Alert tone="danger">{t(marketError)}</Alert></div>}
            </div>
            {market.length > 0 && (
              <Table head={[t("Block"), t("Country"), t("Price"), ""]}>
                {market.map((m) => (
                  <tr key={m.cidr}>
                    <Td><code className="font-mono text-sm">{m.cidr}</code></Td>
                    <Td className="text-body">{m.country || "—"}</Td>
                    <Td className="text-body">{m.monthly === null ? "—" : `${formatMoney(Math.round(m.monthly * 100), m.currency, locale)}${t("/mo")}`}</Td>
                    <Td>
                      <ActionForm action={order} className="flex flex-wrap items-center justify-end gap-3">
                        <input type="hidden" name="cidr" value={m.cidr} />
                        <Checkbox name="confirm" label={t("I order this block, billed monthly by IPXO")} />
                        <SubmitButton size="sm">{t("Lease")}</SubmitButton>
                      </ActionForm>
                    </Td>
                  </tr>
                ))}
              </Table>
            )}
            {query.prefix && !marketError && !market.length && <p className="px-5 pb-5 text-sm text-muted">{t("No blocks found.")}</p>}
          </Card>
        )}
      </div>
    </>
  );
}
