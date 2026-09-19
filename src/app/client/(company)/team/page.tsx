import { and, asc, eq, ne, sql } from "drizzle-orm";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { ConfirmButton } from "@/components/confirm-button";
import { Badge, Button, Card, CardHeader, Field, Input, PageHeader, Select, Table, Td } from "@/components/ui";
import { getDb, schema } from "@/db";
import { getLocale, getT } from "@/i18n";
import { requireAccount, ROLE_LABEL } from "@/lib/account";
import { displayName, formatDate } from "@/lib/format";
import { changeRole, invite, leaveTeam, removeMember, setMemberSites, setRequire2fa, transferOwnership } from "./actions";

const ROLE_HELP: Record<string, string> = {
  admin: "Everything: services, billing and the team.",
  developer: "Manages services: domains, backups, deploys, tools. No billing.",
  billing: "Plans, invoices and payments only.",
};

export default async function Team() {
  const { user, account, can } = await requireAccount("support");
  const db = await getDb();
  const [t, locale, members, sites] = await Promise.all([
    getT(),
    getLocale(),
    db
      .select({ m: schema.companyMembers, u: { firstName: schema.users.firstName, lastName: schema.users.lastName, email: schema.users.email, totpEnabledAt: schema.users.totpEnabledAt } })
      .from(schema.companyMembers)
      .leftJoin(schema.users, eq(schema.users.id, schema.companyMembers.userId))
      .where(eq(schema.companyMembers.companyId, account.id))
      // The owner first, then by seniority.
      .orderBy(sql`${schema.companyMembers.role} <> 'owner'`, asc(schema.companyMembers.invitedAt)),
    db.select({ id: schema.workloads.id, name: schema.workloads.name }).from(schema.workloads).where(and(eq(schema.workloads.companyId, account.id), eq(schema.workloads.environment, "live"), ne(schema.workloads.status, "deleted"))).orderBy(asc(schema.workloads.name)),
  ]);
  const manage = can("manage");

  return (
    <>
      <PageHeader title={t("Users")} description={t("People who can work on {account}.", { account: account.name })} />
      <div className="space-y-6">
        <Card>
          <Table head={[t("Name"), t("Email"), "2FA", t("Role"), t("Access"), ""]}>
            {members.map(({ m, u }) => (
              <tr key={m.id}>
                <Td className="font-medium">{u ? displayName(u) : "—"}{m.userId === user.id && <span className="ml-2 text-xs font-normal text-muted">{t("You")}</span>}</Td>
                <Td className="text-body">{m.email}</Td>
                <Td>{!m.acceptedAt ? <Badge tone="warning">{t("Invited {date}", { date: formatDate(m.invitedAt, locale) })}</Badge> : u?.totpEnabledAt ? <Badge tone="success">{t("Enabled")}</Badge> : <span className="text-muted">{t("Disabled")}</span>}</Td>
                <Td>
                  {manage && m.role !== "owner" ? (
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
                <Td>
                  {m.role !== "developer" ? (
                    <span className="text-muted">{t("All services")}</span>
                  ) : manage ? (
                    <details>
                      <summary className="cursor-pointer text-link">{m.workloadIds?.length ? t("{n} services", { n: m.workloadIds.length }) : t("All services")}</summary>
                      <form action={setMemberSites} className="mt-2 space-y-1.5 rounded-theme border border-border p-3">
                        <input type="hidden" name="id" value={m.id} />
                        {sites.map((s) => (
                          <label key={s.id} className="flex items-center gap-2 text-sm"><input type="checkbox" name="workloadId" value={s.id} defaultChecked={m.workloadIds?.includes(s.id)} className="accent-(--accent)" />{s.name}</label>
                        ))}
                        <p className="text-xs text-muted">{t("Nothing ticked = every service.")}</p>
                        <Button size="sm" variant="secondary">{t("Save")}</Button>
                      </form>
                    </details>
                  ) : m.workloadIds?.length ? t("{n} services", { n: m.workloadIds.length }) : t("All services")}
                </Td>
                <Td className="text-right">
                  {manage && m.role !== "owner" && (
                    <div className="flex justify-end gap-1">
                      {account.role === "owner" && m.acceptedAt && (
                        <form action={transferOwnership}>
                          <input type="hidden" name="id" value={m.id} />
                          <ConfirmButton size="sm" variant="ghost" message={t("Make this person the company owner? You will stay as administrator.")}>{t("Make owner")}</ConfirmButton>
                        </form>
                      )}
                      <form action={removeMember}>
                        <input type="hidden" name="id" value={m.id} />
                        <Button size="sm" variant="ghost">{t("Remove")}</Button>
                      </form>
                    </div>
                  )}
                </Td>
              </tr>
            ))}
          </Table>
        </Card>

        {manage && (
          <Card>
            <CardHeader
              title={t("Two-factor authentication for everyone")}
              description={account.require2fa ? t("Required: members without it can only open their profile until they set it up.") : t("Optional: each member decides for their own account.")}
              action={<ActionForm action={setRequire2fa} className=""><input type="hidden" name="require2fa" value={account.require2fa ? "0" : "1"} /><SubmitButton variant="secondary">{account.require2fa ? t("Make it optional") : t("Require it")}</SubmitButton></ActionForm>}
            />
          </Card>
        )}

        {manage && (
          <Card>
            <CardHeader title={t("Invite users")} description={t("They receive an email with a link valid for 7 days. They need an account with the same email address.")} />
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

        {account.role !== "owner" && (
          <form action={leaveTeam}>
            <input type="hidden" name="companyId" value={account.id} />
            <Button variant="ghost">{t("Leave this company")}</Button>
          </form>
        )}
      </div>
    </>
  );
}
