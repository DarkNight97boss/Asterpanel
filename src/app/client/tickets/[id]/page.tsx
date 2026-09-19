import { notFound } from "next/navigation";
import { and, asc, eq } from "drizzle-orm";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { AUTHOR_COLUMNS, TicketThread } from "@/components/ticket-thread";
import { Button, Card, PageHeader, STATUS_LABEL, StatusBadge, Textarea } from "@/components/ui";
import { getDb, schema } from "@/db";
import { getT } from "@/i18n";
import { requireAccount } from "@/lib/account";
import { closeTicket, replyTicket } from "../../actions";

export default async function ClientTicket({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { account: user } = await requireAccount("support");
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const db = await getDb();
  const ticket = await db.query.tickets.findFirst({
    where: and(eq(schema.tickets.id, id), eq(schema.tickets.clientId, user.id)),
    with: { messages: { with: { author: { columns: AUTHOR_COLUMNS } }, orderBy: asc(schema.ticketMessages.createdAt) } },
  });
  if (!ticket) notFound();
  const t = await getT();

  return (
    <>
      <PageHeader
        title={`#${ticket.number} · ${ticket.subject}`}
        description={<StatusBadge status={ticket.status} label={t(STATUS_LABEL[ticket.status])} />}
        action={
          ticket.status !== "closed" && (
            <form action={closeTicket}>
              <input type="hidden" name="ticketId" value={ticket.id} />
              <Button variant="secondary">{t("Close ticket")}</Button>
            </form>
          )
        }
      />
      <TicketThread messages={ticket.messages} />
      <Card className="mt-6 p-5">
        <ActionForm action={replyTicket}>
          <input type="hidden" name="ticketId" value={ticket.id} />
          <Textarea name="body" rows={5} required placeholder={t("Write a reply…")} />
          <SubmitButton>{t("Send reply")}</SubmitButton>
        </ActionForm>
      </Card>
    </>
  );
}
