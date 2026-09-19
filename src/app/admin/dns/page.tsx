import { asc, count, eq } from "drizzle-orm";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { Card, CardHeader, EmptyState, Field, Input, PageHeader, Table, Td, Textarea } from "@/components/ui";
import { getDb, schema } from "@/db";
import { getT } from "@/i18n";
import { requireAdmin } from "@/lib/auth";
import { displayName } from "@/lib/format";
import { getSettings } from "@/lib/settings";
import { saveDnsSettings, syncDnsNow } from "../platform-actions";

export default async function AdminDns() {
  await requireAdmin();
  const db = await getDb();
  const [t, dns, zones] = await Promise.all([
    getT(),
    getSettings("dns"),
    db.select({ zone: schema.dnsZones, records: count(schema.dnsRecords.id), owner: { firstName: schema.users.firstName, lastName: schema.users.lastName, email: schema.users.email } }).from(schema.dnsZones).innerJoin(schema.users, eq(schema.users.id, schema.dnsZones.clientId)).leftJoin(schema.dnsRecords, eq(schema.dnsRecords.zoneId, schema.dnsZones.id)).groupBy(schema.dnsZones.id, schema.users.id).orderBy(asc(schema.dnsZones.name)),
  ]);
  return (
    <>
      <PageHeader title="DNS" description={t("Every node runs an authoritative name server for the domains customers host here.")} />
      <div className="grid items-start gap-6 xl:grid-cols-2">
        <Card>
          <CardHeader title={t("Name servers")} description={t("Host names customers set at their registrar. Create A records for them pointing at your nodes (port 53 UDP/TCP must be open).")} />
          <div className="p-6 pt-4">
            <ActionForm action={saveDnsSettings}>
              <Field label={t("Name servers")} hint={t("One per line, at least two on different nodes.")}><Textarea name="nameservers" rows={4} defaultValue={dns.nameservers.join("\n")} className="font-mono" spellCheck={false} placeholder={"ns1.example.com\nns2.example.com"} /></Field>
              <Field label={t("Hostmaster email")}><Input name="hostmaster" type="email" defaultValue={dns.hostmaster} placeholder="hostmaster@example.com" /></Field>
              <SubmitButton>{t("Save")}</SubmitButton>
            </ActionForm>
          </div>
        </Card>
        <Card>
          <CardHeader title={t("Synchronise")} description={t("Zones are pushed to every node on each change. Use this after adding a node or if one was offline.")} />
          <div className="p-6 pt-4">
            <ActionForm action={syncDnsNow}><SubmitButton variant="secondary">{t("Push DNS to all nodes")}</SubmitButton></ActionForm>
          </div>
        </Card>
      </div>
      <Card className="mt-6">
        {zones.length ? (
          <Table head={[t("Domain"), t("Client"), t("Records"), "Serial"]}>
            {zones.map(({ zone, records, owner }) => (
              <tr key={zone.id}><Td className="font-medium">{zone.name}</Td><Td className="text-body">{displayName(owner)}</Td><Td>{records}</Td><Td className="text-body">{zone.serial}</Td></tr>
            ))}
          </Table>
        ) : (
          <EmptyState title={t("No domains yet")} />
        )}
      </Card>
    </>
  );
}
