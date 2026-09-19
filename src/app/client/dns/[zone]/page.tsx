import Link from "next/link";
import { redirect } from "next/navigation";
import { notFound } from "next/navigation";
import { and, asc, desc, eq } from "drizzle-orm";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { Badge, Button, Card, CardHeader, DataField, EmptyState, Field, Input, PageHeader, Select, Table, Td, Textarea } from "@/components/ui";
import { getDb, schema } from "@/db";
import { DNS_TYPES } from "@/db/schema";
import { getLocale, getT } from "@/i18n";
import { formatDateTime } from "@/lib/format";
import { DNS_TEMPLATES } from "@/platform/dns-tools";
import { requireAccount } from "@/lib/account";
import { getSettings } from "@/lib/settings";
import { addRecord, applyTemplate, checkEmailSetup, deleteRecord, deleteZone, importZoneFile, restoreSnapshot } from "../actions";

const ttlLabel = (s: number) => (s % 86400 === 0 ? `${s / 86400} d` : s % 3600 === 0 ? `${s / 3600} h` : s % 60 === 0 ? `${s / 60} min` : `${s} s`);

export default async function DnsZone({ params }: { params: Promise<{ zone: string }> }) {
  const { account } = await requireAccount("hosting");
  if (account.only) redirect("/client?denied=1");
  const { zone: zoneId } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(zoneId)) notFound();
  const db = await getDb();
  const [zone] = await db.select().from(schema.dnsZones).where(and(eq(schema.dnsZones.id, zoneId), eq(schema.dnsZones.companyId, account.id)));
  if (!zone) notFound();
  const [t, locale, snapshots, dns, records] = await Promise.all([getT(), getLocale(), db.select().from(schema.dnsSnapshots).where(eq(schema.dnsSnapshots.zoneId, zone.id)).orderBy(desc(schema.dnsSnapshots.createdAt)).limit(10), getSettings("dns"), db.select().from(schema.dnsRecords).where(eq(schema.dnsRecords.zoneId, zone.id)).orderBy(asc(schema.dnsRecords.type), asc(schema.dnsRecords.name))]);

  return (
    <>
      <PageHeader title={zone.name} description={<Link href="/client/dns" className="hover:text-link">← {t("DNS management")}</Link>} />
      <div className="space-y-6">
        <Card className="p-6">
          <h2 className="mb-2 text-xl font-medium">{t("Name servers")}</h2>
          <p className="mb-5 text-sm text-muted">{t("Set these at the registrar of {domain}. Changes can take up to 48 hours to spread.", { domain: zone.name })}</p>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {dns.nameservers.length ? dns.nameservers.map((ns, i) => <DataField key={ns} label={`${t("Name server")} ${i + 1}`}><span className="select-all">{ns}</span></DataField>) : <p className="text-sm text-warning sm:col-span-4">{t("Name servers are not configured yet, so domains added here will not resolve. Ask the provider to set them up.")}</p>}
          </div>
        </Card>

        <Card>
          <CardHeader title={t("Add DNS record")} />
          <div className="p-6 pt-4">
            <ActionForm action={addRecord}>
              <input type="hidden" name="zoneId" value={zone.id} />
              <div className="grid gap-4 md:grid-cols-[7rem_1fr_1.6fr_7rem_8rem]">
                <Field label={t("Type")}><Select name="type" defaultValue="A">{DNS_TYPES.map((ty) => <option key={ty}>{ty}</option>)}</Select></Field>
                <Field label={t("Name")} hint={t("@ = the domain itself")}><Input name="name" placeholder="www" autoCapitalize="none" spellCheck={false} /></Field>
                <Field label={t("Value")} hint={t("IP, host name or text, depending on the type")}><Input name="value" required placeholder="203.0.113.10" autoCapitalize="none" spellCheck={false} /></Field>
                <Field label={t("Priority")} hint="MX, SRV"><Input name="priority" type="number" min={0} max={65535} defaultValue={10} /></Field>
                <Field label="TTL">
                  <Select name="ttl" defaultValue="3600">
                    {[300, 3600, 14400, 86400].map((s) => <option key={s} value={s}>{ttlLabel(s)}</option>)}
                  </Select>
                </Field>
              </div>
              <SubmitButton>{t("Add DNS record")}</SubmitButton>
            </ActionForm>
          </div>
        </Card>

        <Card>
          {records.length ? (
            <Table head={[t("Type"), t("Name"), t("Value"), "TTL", ""]}>
              {records.map((r) => (
                <tr key={r.id}>
                  <Td><Badge>{r.type}</Badge></Td>
                  <Td className="font-mono text-xs">{r.name === "@" ? zone.name : `${r.name}.${zone.name}`}</Td>
                  <Td className="max-w-md font-mono text-xs break-all">{(r.type === "MX" || r.type === "SRV") && <span className="mr-2 text-muted">{r.priority}</span>}{r.value}</Td>
                  <Td className="text-body">{ttlLabel(r.ttl)}</Td>
                  <Td className="text-right">
                    <form action={deleteRecord}>
                      <input type="hidden" name="zoneId" value={zone.id} />
                      <input type="hidden" name="recordId" value={r.id} />
                      <Button size="sm" variant="ghost">{t("Remove")}</Button>
                    </form>
                  </Td>
                </tr>
              ))}
            </Table>
          ) : (
            <EmptyState title={t("No records yet")} description={t("Start with an A record for @ and one for www pointing to your server.")} />
          )}
        </Card>

        <div className="grid items-start gap-6 xl:grid-cols-2">
          <Card>
            <CardHeader title={t("Ready-made records")} description={t("Adds the records a service needs. What is already there is left alone.")} />
            <div className="p-6 pt-4">
              <ActionForm action={applyTemplate}>
                <input type="hidden" name="zoneId" value={zone.id} />
                <Select name="template" defaultValue="">
                  <option value="" disabled>{t("Choose a template")}</option>
                  {DNS_TEMPLATES.map((tpl) => <option key={tpl.id} value={tpl.id}>{t(tpl.name)} — {t(tpl.description)}</option>)}
                </Select>
                <SubmitButton variant="secondary">{t("Add records")}</SubmitButton>
              </ActionForm>
            </div>
          </Card>
          <Card>
            <CardHeader title={t("Import a zone file")} description={t("Paste the export of your current DNS provider (BIND format). SOA and NS records are skipped: those are set by us.")} />
            <div className="p-6 pt-4">
              <ActionForm action={importZoneFile}>
                <input type="hidden" name="zoneId" value={zone.id} />
                <Textarea name="zonefile" rows={5} required className="font-mono text-xs" placeholder={"www 3600 IN A 203.0.113.10\n@ IN MX 10 mail.example.com."} />
                <SubmitButton variant="secondary">{t("Import")}</SubmitButton>
              </ActionForm>
            </div>
          </Card>
        </div>

        <Card>
          <CardHeader title={t("Email check")} description={t("Reads the public DNS of {domain} the way a receiving mail server does: MX, SPF and DMARC.", { domain: zone.name })} action={<ActionForm action={checkEmailSetup} className=""><input type="hidden" name="zoneId" value={zone.id} /><SubmitButton variant="secondary">{t("Check now")}</SubmitButton></ActionForm>} />
        </Card>

        {snapshots.length > 0 && (
          <Card>
            <CardHeader title={t("History")} description={t("The zone as it was before each change. Restoring can itself be undone.")} />
            <ul className="divide-y divide-border border-t border-border">
              {snapshots.map((sn) => (
                <li key={sn.id} className="flex flex-wrap items-center justify-between gap-3 px-6 py-3 text-sm">
                  <span>{formatDateTime(sn.createdAt, locale)} <span className="ml-2 text-muted">{sn.reason} · {t("{n} records", { n: sn.records.length })}</span></span>
                  <ActionForm action={restoreSnapshot} className="">
                    <input type="hidden" name="zoneId" value={zone.id} />
                    <input type="hidden" name="snapshotId" value={sn.id} />
                    <SubmitButton size="sm" variant="ghost">{t("Restore this version")}</SubmitButton>
                  </ActionForm>
                </li>
              ))}
            </ul>
          </Card>
        )}

        <Card className="border-danger/40">
          <CardHeader title={t("Remove this domain")} description={t("All its records stop resolving as soon as the name servers update.")} />
          <div className="p-6 pt-4">
            <ActionForm action={deleteZone} className="flex max-w-xl flex-wrap items-start gap-3">
              <input type="hidden" name="zoneId" value={zone.id} />
              <Input name="confirm" placeholder={t("Type “{name}” to confirm", { name: zone.name })} required className="flex-1" autoComplete="off" />
              <SubmitButton variant="danger">{t("Remove domain")}</SubmitButton>
            </ActionForm>
          </div>
        </Card>
      </div>
    </>
  );
}
