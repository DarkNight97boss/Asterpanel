import Link from "next/link";
import { notFound } from "next/navigation";
import { asc, eq } from "drizzle-orm";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { AUTHOR_COLUMNS, TicketThread } from "@/components/ticket-thread";
import { Button, Card, PageHeader, StatusBadge, STATUS_LABEL, Textarea } from "@/components/ui";
import { getDb, schema } from "@/db";
import { getT } from "@/i18n";
import { displayName } from "@/lib/auth";
import { setTicketStatus, staffReply } from "../../actions";

export default async function AdminTicket({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const db = await getDb();
  const ticket = await db.query.tickets.findFirst({
    where: eq(schema.tickets.id, id),
    with: {
      client: { columns: { passwordHash: false } },
      messages: { with: { author: { columns: AUTHOR_COLUMNS } }, orderBy: asc(schema.ticketMessages.createdAt) },
    },
  });
  if (!ticket) notFound();
  const t = await getT();
  const closed = ticket.status === "closed";

  return (
    <>
      <PageHeader
        title={`#${ticket.number} · ${ticket.subject}`}
        description={
          <>
            <StatusBadge status={ticket.status} label={t(STATUS_LABEL[ticket.status])} />{" "}
            <Link href={`/admin/clients/${ticket.clientId}`} className="hover:text-link">{displayName(ticket.client)}</Link>
            {" · "}<span className="capitalize">{ticket.department}</span> · {t({ low: "Low", medium: "Medium", high: "High" }[ticket.priority])}
          </>
        }
        action={
          <form action={setTicketStatus}>
            <input type="hidden" name="ticketId" value={ticket.id} />
            <input type="hidden" name="status" value={closed ? "open" : "closed"} />
            <Button variant="secondary">{closed ? t("Reopen") : t("Close ticket")}</Button>
          </form>
        }
      />
      <TicketThread messages={ticket.messages} />
      <Card className="mt-6 p-5">
        <ActionForm action={staffReply}>
          <input type="hidden" name="ticketId" value={ticket.id} />
          <Textarea name="body" rows={6} required placeholder={t("Write a reply…")} />
          <SubmitButton>{t("Send reply")}</SubmitButton>
        </ActionForm>
      </Card>
    </>
  );
}
