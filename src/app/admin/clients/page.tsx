import Link from "next/link";
import { and, desc, eq, ilike, or } from "drizzle-orm";
import { Card, EmptyState, Input, PageHeader, StatusBadge, STATUS_LABEL, Table, Td } from "@/components/ui";
import { getDb, schema } from "@/db";
import { getLocale, getT } from "@/i18n";
import { displayName, requireArea } from "@/lib/auth";
import { formatDate } from "@/lib/format";

export default async function Clients({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  await requireArea("clients");
  const q = ((await searchParams).q ?? "").trim().slice(0, 100);
  const like = `%${q.replace(/[%_\\]/g, "\\$&")}%`;
  const db = await getDb();
  const [t, locale, clients] = await Promise.all([
    getT(),
    getLocale(),
    db
      .select()
      .from(schema.users)
      .where(
        and(
          eq(schema.users.role, "client"),
          q ? or(ilike(schema.users.email, like), ilike(schema.users.firstName, like), ilike(schema.users.lastName, like), ilike(schema.users.company, like)) : undefined,
        ),
      )
      .orderBy(desc(schema.users.createdAt))
      .limit(200),
  ]);

  return (
    <>
      <PageHeader
        title={t("Clients")}
        action={
          <form>
            <Input name="q" type="search" defaultValue={q} placeholder={t("Search…")} className="w-56" />
          </form>
        }
      />
      <Card>
        {clients.length ? (
          <Table head={[t("Name"), t("Email"), t("Company"), t("Registered"), t("Status")]}>
            {clients.map((c) => (
              <tr key={c.id}>
                <Td>
                  <Link href={`/admin/clients/${c.id}`} className="font-medium hover:text-link">{displayName(c)}</Link>
                </Td>
                <Td className="text-muted">{c.email}</Td>
                <Td>{c.company || "—"}</Td>
                <Td>{formatDate(c.createdAt, locale)}</Td>
                <Td><StatusBadge status={c.status} label={t(STATUS_LABEL[c.status])} /></Td>
              </tr>
            ))}
          </Table>
        ) : (
          <EmptyState title={t("No clients found")} />
        )}
      </Card>
    </>
  );
}
