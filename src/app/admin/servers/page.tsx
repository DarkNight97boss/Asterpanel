import Link from "next/link";
import { asc, count, eq } from "drizzle-orm";
import { Badge, ButtonLink, Card, EmptyState, PageHeader, Table, Td } from "@/components/ui";
import { getDb, schema } from "@/db";
import { getT } from "@/i18n";
import { requireAdmin } from "@/lib/auth";
import { getProvisioningModule } from "@/modules/provisioning";

export default async function Servers() {
  await requireAdmin();
  const db = await getDb();
  const [t, servers] = await Promise.all([
    getT(),
    db
      .select({ server: schema.servers, accounts: count(schema.services.id) })
      .from(schema.servers)
      .leftJoin(schema.services, eq(schema.services.serverId, schema.servers.id))
      .groupBy(schema.servers.id)
      .orderBy(asc(schema.servers.name)),
  ]);

  return (
    <>
      <PageHeader title={t("Servers")} description={t("Machines your provisioning modules connect to.")} action={<ButtonLink href="/admin/servers/new">{t("New server")}</ButtonLink>} />
      <Card>
        {servers.length ? (
          <Table head={[t("Name"), t("Hostname"), t("Module"), t("Accounts"), ""]}>
            {servers.map(({ server: s, accounts }) => (
              <tr key={s.id}>
                <Td><Link href={`/admin/servers/${s.id}`} className="font-medium hover:text-primary">{s.name}</Link></Td>
                <Td className="font-mono text-xs">{s.hostname}</Td>
                <Td>{getProvisioningModule(s.module).name}</Td>
                <Td>{accounts}{s.maxAccounts > 0 && ` / ${s.maxAccounts}`}</Td>
                <Td className="text-right">{s.active ? <Badge tone="success">{t("Active")}</Badge> : <Badge>{t("Disabled")}</Badge>}</Td>
              </tr>
            ))}
          </Table>
        ) : (
          <EmptyState title={t("No servers yet")} description={t("Add one to automate account creation with modules like cPanel & WHM.")} />
        )}
      </Card>
    </>
  );
}
