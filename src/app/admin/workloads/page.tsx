import Link from "next/link";
import { desc, ne } from "drizzle-orm";
import { AutoRefresh } from "@/components/auto-refresh";
import { Card, EmptyState, PageHeader, StatusBadge, Table, Td } from "@/components/ui";
import { getDb, schema } from "@/db";
import { getLocale, getT } from "@/i18n";
import { displayName, formatDate } from "@/lib/format";
import { WORKLOAD_LABEL } from "@/platform/ui";
import { requireArea } from "@/lib/auth";

export default async function AdminWorkloads() {
  await requireArea("platform");
  const db = await getDb();
  const [t, locale, rows] = await Promise.all([
    getT(),
    getLocale(),
    db.query.workloads.findMany({
      where: ne(schema.workloads.status, "deleted"),
      with: { client: { columns: { passwordHash: false } }, node: { columns: { name: true } }, domains: true },
      orderBy: desc(schema.workloads.createdAt),
      limit: 300,
    }),
  ]);
  return (
    <>
      <AutoRefresh active={rows.some((w) => w.status === "creating" || w.status === "deleting")} />
      <PageHeader title={t("Workloads")} description={t("Everything running on the platform.")} />
      <Card>
        {rows.length ? (
          <Table head={[t("Name"), t("Type"), t("Client"), t("Node"), t("Created"), t("Status")]}>
            {rows.map((w) => (
              <tr key={w.id}>
                <Td>
                  <Link href={`/client/workloads/${w.id}`} className="font-medium hover:text-link">{w.name}</Link>
                  <span className="block text-xs text-muted">{w.domains.find((d) => d.isPrimary)?.hostname ?? w.slug}</span>
                </Td>
                <Td>{t(WORKLOAD_LABEL[w.type].one)}</Td>
                <Td><Link href={`/admin/clients/${w.clientId}`} className="hover:text-link">{displayName(w.client)}</Link></Td>
                <Td>{w.node.name}</Td>
                <Td>{formatDate(w.createdAt, locale)}</Td>
                <Td><StatusBadge status={w.status} label={t(w.status)} /></Td>
              </tr>
            ))}
          </Table>
        ) : (
          <EmptyState title={t("No workloads yet")} />
        )}
      </Card>
    </>
  );
}
