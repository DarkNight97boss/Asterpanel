import Link from "next/link";
import { notFound } from "next/navigation";
import { and, desc, eq } from "drizzle-orm";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { ProfileFields } from "@/components/profile-fields";
import { Button, Card, CardHeader, EmptyState, Field, Input, PageHeader, Select, StatusBadge, STATUS_LABEL, Table, Td, Textarea } from "@/components/ui";
import { getDb, schema } from "@/db";
import { getLocale, getT } from "@/i18n";
import { displayName, requireArea } from "@/lib/auth";
import { formatDate, formatMoney, invoiceLabel } from "@/lib/format";
import { getSettings } from "@/lib/settings";
import { addCredit, saveClient, signInAsClient } from "../../actions";

export default async function ClientDetail({ params }: { params: Promise<{ id: string }> }) {
  await requireArea("clients");
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const db = await getDb();
  const client = await db.query.users.findFirst({ where: and(eq(schema.users.id, id), eq(schema.users.role, "client")), columns: { passwordHash: false } });
  if (!client) notFound();

  // Companies this person owns: credit belongs to the company, not to the login.
  const owned = await db.select({ id: schema.companies.id, name: schema.companies.name, creditBalance: schema.companies.creditBalance }).from(schema.companies).innerJoin(schema.companyMembers, and(eq(schema.companyMembers.companyId, schema.companies.id), eq(schema.companyMembers.role, "owner"))).where(eq(schema.companyMembers.userId, id));
  const [t, locale, billing, services, invoices] = await Promise.all([
    getT(),
    getLocale(),
    getSettings("billing"),
    db.query.services.findMany({ where: eq(schema.services.clientId, id), with: { product: true }, orderBy: desc(schema.services.createdAt) }),
    db.select().from(schema.invoices).where(eq(schema.invoices.clientId, id)).orderBy(desc(schema.invoices.createdAt)).limit(20),
  ]);

  return (
    <>
      <PageHeader
        title={displayName(client)}
        description={`${client.email} · ${t("Registered")} ${formatDate(client.createdAt, locale)}`}
        action={client.role === "client" && client.status === "active" && <form action={signInAsClient}><input type="hidden" name="clientId" value={client.id} /><Button variant="secondary">{t("Sign in as this client")}</Button></form>}
      />
      <div className="grid gap-6 xl:grid-cols-2">
        <Card className="xl:row-span-2">
          <CardHeader title={t("Profile")} />
          <div className="p-5">
            <ActionForm action={saveClient}>
              <input type="hidden" name="id" value={client.id} />
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label={t("Email")}>
                  <Input name="email" type="email" defaultValue={client.email} required />
                </Field>
                <Field label={t("Status")}>
                  <Select name="status" defaultValue={client.status}>
                    <option value="active">{t("Active")}</option>
                    <option value="suspended">{t("Suspended")}</option>
                    <option value="closed">{t("Closed")}</option>
                  </Select>
                </Field>
              </div>
              <ProfileFields user={client} />
              <Field label={t("Private notes")} hint={t("Only visible to staff.")}>
                <Textarea name="adminNotes" defaultValue={client.adminNotes} rows={3} />
              </Field>
              <SubmitButton>{t("Save")}</SubmitButton>
            </ActionForm>
          </div>
        </Card>

        <Card>
          <CardHeader title={t("Services")} />
          {services.length ? (
            <Table head={[t("Service"), t("Next due"), t("Status")]}>
              {services.map((s) => (
                <tr key={s.id}>
                  <Td>
                    <Link href={`/admin/services/${s.id}`} className="font-medium hover:text-link">{s.product.name}</Link>
                    {s.domain && <span className="block text-xs text-muted">{s.domain}</span>}
                  </Td>
                  <Td>{formatDate(s.nextDueDate, locale)}</Td>
                  <Td><StatusBadge status={s.status} label={t(STATUS_LABEL[s.status])} /></Td>
                </tr>
              ))}
            </Table>
          ) : (
            <EmptyState title={t("No services yet")} />
          )}
        </Card>

        <Card>
          <CardHeader title={t("Invoices")} />
          {invoices.length ? (
            <Table head={[t("Invoice"), t("Due"), t("Total"), t("Status")]}>
              {invoices.map((inv) => (
                <tr key={inv.id}>
                  <Td>
                    <Link href={`/admin/invoices/${inv.id}`} className="font-medium hover:text-link">{invoiceLabel(billing.invoicePrefix, inv)}</Link>
                  </Td>
                  <Td>{formatDate(inv.dueDate, locale)}</Td>
                  <Td>{formatMoney(inv.total, inv.currency, locale)}</Td>
                  <Td><StatusBadge status={inv.status} label={t(STATUS_LABEL[inv.status])} /></Td>
                </tr>
              ))}
            </Table>
          ) : (
            <EmptyState title={t("No invoices yet")} />
          )}
        </Card>
        {owned.map((co) => (
          <Card key={co.id}>
            <CardHeader title={`${t("Credit")} — ${co.name}`} description={t("Prepaid balance, spent on new invoices before any card is charged.")} />
            <div className="p-5">
              <p className="mb-4 text-2xl">{formatMoney(co.creditBalance, billing.currency, locale)}</p>
              <ActionForm action={addCredit}>
                <input type="hidden" name="companyId" value={co.id} />
                <div className="grid gap-4 sm:grid-cols-[10rem_1fr]">
                  <Field label={t("Amount")} hint={t("Negative to remove")}><Input name="amount" required inputMode="decimal" placeholder="25.00" /></Field>
                  <Field label={t("Reason")}><Input name="reason" required maxLength={200} /></Field>
                </div>
                <SubmitButton variant="secondary">{t("Adjust credit")}</SubmitButton>
              </ActionForm>
            </div>
          </Card>
        ))}
      </div>
    </>
  );
}
