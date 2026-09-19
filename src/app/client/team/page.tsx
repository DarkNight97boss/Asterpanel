import { asc, eq } from "drizzle-orm";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { Badge, Button, Card, CardHeader, Field, Input, PageHeader, Select, Table, Td } from "@/components/ui";
import { getDb, schema } from "@/db";
import { getLocale, getT } from "@/i18n";
import { requireAccount, ROLE_LABEL } from "@/lib/account";
import { displayName, formatDate } from "@/lib/format";
import { changeRole, invite, leaveTeam, removeMember } from "./actions";

const ROLE_HELP: Record<string, string> = {
  admin: "Everything: services, billing and the team.",
  developer: "Manages services: domains, backups, deploys, tools. No billing.",
  billing: "Plans, invoices and payments only.",
};

export default async function Team() {
  const { user, account, can } = await requireAccount("support");
  const db = await getDb();
  const [t, locale, [owner], members] = await Promise.all([
    getT(),
    getLocale(),
    db.select().from(schema.users).where(eq(schema.users.id, account.id)),
    db
      .select({ m: schema.teamMembers, u: { firstName: schema.users.firstName, lastName: schema.users.lastName, email: schema.users.email } })
      .from(schema.teamMembers)
      .leftJoin(schema.users, eq(schema.users.id, schema.teamMembers.memberId))
      .where(eq(schema.teamMembers.ownerId, account.id))
      .orderBy(asc(schema.teamMembers.invitedAt)),
  ]);
  const manage = can("manage");

  return (
    <>
      <PageHeader title={t("Team")} description={t("People who can work on {account}.", { account: account.name })} />
      <div className="space-y-6">
        <Card>
          <Table head={[t("Name"), t("Email"), t("Role"), t("Status"), ""]}>
            <tr>
              <Td className="font-medium">{displayName(owner)}</Td>
              <Td className="text-body">{owner.email}</Td>
              <Td>{t(ROLE_LABEL.owner)}</Td>
              <Td><Badge tone="success">{t("Active")}</Badge></Td>
              <Td />
            </tr>
            {members.map(({ m, u }) => (
              <tr key={m.id}>
                <Td className="font-medium">{u ? displayName(u) : "—"}</Td>
                <Td className="text-body">{m.email}</Td>
                <Td>
                  {manage ? (
                    <form action={changeRole} className="flex items-center gap-2">
                      <input type="hidden" name="id" value={m.id} />
                      <Select name="role" defaultValue={m.role} className="!min-h-8 w-40 py-1">
                        {(["admin", "developer", "billing"] as const).map((r) => <option key={r} value={r}>{t(ROLE_LABEL[r])}</option>)}
                      </Select>
                      <Button size="sm" variant="ghost">{t("Save")}</Button>
                    </form>
                  ) : (
                    t(ROLE_LABEL[m.role])
                  )}
                </Td>
                <Td>{m.acceptedAt ? <Badge tone="success">{t("Active")}</Badge> : <Badge tone="warning">{t("Invited {date}", { date: formatDate(m.invitedAt, locale) })}</Badge>}</Td>
                <Td className="text-right">
                  {manage && (
                    <form action={removeMember}>
                      <input type="hidden" name="id" value={m.id} />
                      <Button size="sm" variant="ghost">{t("Remove")}</Button>
                    </form>
                  )}
                </Td>
              </tr>
            ))}
          </Table>
        </Card>

        {manage && (
          <Card>
            <CardHeader title={t("Invite a person")} description={t("They receive an email with a link valid for 7 days. They need an account with the same email address.")} />
            <div className="p-6 pt-4">
              <ActionForm action={invite}>
                <div className="grid gap-4 md:grid-cols-[1fr_14rem]">
                  <Field label={t("Email")}><Input name="email" type="email" required placeholder="name@example.com" /></Field>
                  <Field label={t("Role")}>
                    <Select name="role" defaultValue="developer">
                      {(["admin", "developer", "billing"] as const).map((r) => <option key={r} value={r}>{t(ROLE_LABEL[r])}</option>)}
                    </Select>
                  </Field>
                </div>
                <ul className="space-y-1 text-xs text-muted">
                  {Object.entries(ROLE_HELP).map(([r, help]) => <li key={r}><strong className="font-medium">{t(ROLE_LABEL[r as "admin"])}</strong> — {t(help)}</li>)}
                </ul>
                <SubmitButton>{t("Send invitation")}</SubmitButton>
              </ActionForm>
            </div>
          </Card>
        )}

        {account.id !== user.id && (
          <form action={leaveTeam}>
            <input type="hidden" name="ownerId" value={account.id} />
            <Button variant="ghost">{t("Leave this team")}</Button>
          </form>
        )}
      </div>
    </>
  );
}
