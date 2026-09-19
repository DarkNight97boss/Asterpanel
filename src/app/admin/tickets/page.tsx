import Link from "next/link";
import { desc, ne } from "drizzle-orm";
import { Badge, Card, EmptyState, PageHeader, StatusBadge, STATUS_LABEL, Table, Td } from "@/components/ui";
import { getDb, schema } from "@/db";
import { getLocale, getT } from "@/i18n";
import { displayName } from "@/lib/auth";
import { formatDateTime } from "@/lib/format";

export default async function Tickets({ searchParams }: { searchParams: Promise<{ all?: string }> }) {
  const all = !!(await searchParams).all;
  const db = await getDb();
  const [t, locale, tickets] = await Promise.all([
    getT(),
    getLocale(),
    db.query.tickets.findMany({
      where: all ? undefined : ne(schema.tickets.status, "closed"),
      with: { client: { columns: { passwordHash: false } } },
      orderBy: desc(schema.tickets.lastReplyAt),
      limit: 300,
    }),
  ]);

  return (
    <>
      <PageHeader
        title={t("Tickets")}
        action={<Link href={all ? "/admin/tickets" : "/admin/tickets?all=1"} className="text-sm text-link">{all ? t("Hide closed") : t("Show closed")}</Link>}
      />
      <Card>
        {tickets.length ? (
          <Table head={["#", t("Subject"), t("Client"), t("Department"), t("Last reply"), t("Status")]}>
            {tickets.map((tk) => (
              <tr key={tk.id}>
                <Td className="text-muted">{tk.number}</Td>
                <Td>
                  <Link href={`/admin/tickets/${tk.id}`} className="font-medium hover:text-link">{tk.subject}</Link>{" "}
                  {tk.priority === "high" && <Badge tone="danger">{t("High")}</Badge>}
                </Td>
                <Td>{displayName(tk.client)}</Td>
                <Td className="capitalize">{tk.department}</Td>
                <Td>{formatDateTime(tk.lastReplyAt, locale)}</Td>
                <Td><StatusBadge status={tk.status} label={t(STATUS_LABEL[tk.status])} /></Td>
              </tr>
            ))}
          </Table>
        ) : (
          <EmptyState title={t("No tickets")} description={t("Nothing is waiting for you.")} />
        )}
      </Card>
    </>
  );
}
