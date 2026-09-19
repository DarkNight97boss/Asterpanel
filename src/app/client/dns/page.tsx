import Link from "next/link";
import { asc, count, eq } from "drizzle-orm";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { Alert, Card, CardHeader, EmptyState, Input, PageHeader, Table, Td } from "@/components/ui";
import { getDb, schema } from "@/db";
import { getLocale, getT } from "@/i18n";
import { requireAccount } from "@/lib/account";
import { formatDate } from "@/lib/format";
import { getSettings } from "@/lib/settings";
import { addZone } from "./actions";

export default async function DnsZones() {
  const { account } = await requireAccount("hosting");
  const db = await getDb();
  const [t, locale, dns, zones] = await Promise.all([
    getT(),
    getLocale(),
    getSettings("dns"),
    db.select({ zone: schema.dnsZones, records: count(schema.dnsRecords.id) }).from(schema.dnsZones).leftJoin(schema.dnsRecords, eq(schema.dnsRecords.zoneId, schema.dnsZones.id)).where(eq(schema.dnsZones.clientId, account.id)).groupBy(schema.dnsZones.id).orderBy(asc(schema.dnsZones.name)),
  ]);

  return (
    <>
      <PageHeader title={t("DNS management")} description={t("Host your domains' DNS here and manage every record from one place.")} />
      {!dns.nameservers.length && <div className="mb-6"><Alert tone="warning">{t("Name servers are not configured yet, so domains added here will not resolve. Ask the provider to set them up.")}</Alert></div>}
      <div className="space-y-6">
        <Card>
          {zones.length ? (
            <Table head={[t("Domain"), t("Records"), t("Added")]}>
              {zones.map(({ zone, records }) => (
                <tr key={zone.id}>
                  <Td><Link href={`/client/dns/${zone.id}`} className="font-medium hover:text-link">{zone.name}</Link></Td>
                  <Td>{records}</Td>
                  <Td className="text-body">{formatDate(zone.createdAt, locale)}</Td>
                </tr>
              ))}
            </Table>
          ) : (
            <EmptyState title={t("No domains yet")} description={t("Add a domain, create its records, then point the domain to our name servers at your registrar.")} />
          )}
        </Card>
        <Card>
          <CardHeader title={t("Add a domain")} />
          <div className="p-6 pt-4">
            <ActionForm action={addZone} className="flex max-w-xl flex-wrap items-start gap-3">
              <Input name="domain" placeholder="example.com" required className="flex-1" autoCapitalize="none" spellCheck={false} />
              <SubmitButton>{t("Add domain")}</SubmitButton>
            </ActionForm>
          </div>
        </Card>
      </div>
    </>
  );
}
