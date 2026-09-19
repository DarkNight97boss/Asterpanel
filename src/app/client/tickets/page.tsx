import Link from "next/link";
import { desc, eq } from "drizzle-orm";
import { ButtonLink, Card, EmptyState, PageHeader, StatusBadge, Table, Td } from "@/components/ui";
import { getDb, schema } from "@/db";
import { getLocale, getT } from "@/i18n";
import { requireAccount } from "@/lib/account";
import { formatDateTime } from "@/lib/format";
import { STATUS_LABEL } from "@/components/ui";

export default async function ClientTickets() {
  const { account: user } = await requireAccount("support");
  const db = await getDb();
  const [t, locale, tickets] = await Promise.all([
    getT(),
    getLocale(),
    db.select().from(schema.tickets).where(eq(schema.tickets.clientId, user.id)).orderBy(desc(schema.tickets.lastReplyAt)),
  ]);

  return (
    <>
      <PageHeader title={t("Support")} action={<ButtonLink href="/client/tickets/new">{t("Open ticket")}</ButtonLink>} />
      <Card>
        {tickets.length ? (
          <Table head={["#", t("Subject"), t("Last reply"), t("Status")]}>
            {tickets.map((tk) => (
              <tr key={tk.id}>
                <Td className="text-muted">{tk.number}</Td>
                <Td>
                  <Link href={`/client/tickets/${tk.id}`} className="font-medium hover:text-link">{tk.subject}</Link>
                </Td>
                <Td>{formatDateTime(tk.lastReplyAt, locale)}</Td>
                <Td><StatusBadge status={tk.status} label={t(STATUS_LABEL[tk.status])} /></Td>
              </tr>
            ))}
          </Table>
        ) : (
          <EmptyState title={t("No tickets yet")} description={t("Need help? Open a ticket and our team will get back to you.")} />
        )}
      </Card>
    </>
  );
}
