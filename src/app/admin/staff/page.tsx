import { asc, desc, inArray, ne } from "drizzle-orm";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { Badge, Card, CardHeader, Field, Input, PageHeader, Select, Table, Td } from "@/components/ui";
import { getDb, schema } from "@/db";
import { getLocale, getT } from "@/i18n";
import { requireAdmin } from "@/lib/auth";
import { displayName, formatDateTime } from "@/lib/format";
import { AREA_LABEL, STAFF_ROLE_HELP, STAFF_ROLE_LABEL, STAFF_ROLES, staffAreas } from "@/lib/staff";
import { addStaff, changeStaffRole, removeStaff } from "./actions";

export const metadata = { title: "Staff" };

export default async function Staff() {
  const me = await requireAdmin();
  const db = await getDb();
  const [t, locale, people] = await Promise.all([getT(), getLocale(), db.select().from(schema.users).where(ne(schema.users.role, "client")).orderBy(asc(schema.users.role), asc(schema.users.email))]);
  const lastSeen = new Map<string, Date>();
  if (people.length) {
    for (const s of await db.select({ userId: schema.sessions.userId, at: schema.sessions.createdAt }).from(schema.sessions).where(inArray(schema.sessions.userId, people.map((p) => p.id))).orderBy(desc(schema.sessions.createdAt))) {
      if (!lastSeen.has(s.userId)) lastSeen.set(s.userId, s.at);
    }
  }
  const options = (["admin", ...STAFF_ROLES] as const).map((r) => <option key={r} value={r}>{t(STAFF_ROLE_LABEL[r])}</option>);

  return (
    <>
      <PageHeader title={t("Staff")} description={t("Who works in the back office and what they can open.")} />
      <div className="space-y-6">
        <Card>
          <Table head={[t("Name"), t("Email"), "2FA", t("Role"), t("Areas"), t("Last sign-in"), ""]}>
            {people.map((p) => (
              <tr key={p.id}>
                <Td className="font-medium">{displayName(p)}{p.id === me.id && <span className="ml-2 text-xs font-normal text-muted">{t("You")}</span>}</Td>
                <Td className="text-body">{p.email}</Td>
                <Td>{p.totpEnabledAt ? <Badge tone="success">{t("Enabled")}</Badge> : <Badge tone="warning">{t("Disabled")}</Badge>}</Td>
                <Td>
                  {p.id === me.id ? (
                    t(STAFF_ROLE_LABEL.admin)
                  ) : (
                    <ActionForm action={changeStaffRole} className="flex items-center gap-2">
                      <input type="hidden" name="id" value={p.id} />
                      <Select name="role" defaultValue={p.role === "admin" ? "admin" : p.staffRole || "manager"} className="!min-h-8 w-44 py-1">{options}</Select>
                      <SubmitButton size="sm" variant="ghost">{t("Save")}</SubmitButton>
                    </ActionForm>
                  )}
                </Td>
                <Td className="text-xs text-muted">{p.role === "admin" ? t("Everything") : staffAreas(p).map((a) => t(AREA_LABEL[a])).join(" · ")}</Td>
                <Td className="text-body">{lastSeen.has(p.id) ? formatDateTime(lastSeen.get(p.id)!, locale) : "—"}</Td>
                <Td className="text-right">
                  {p.id !== me.id && (
                    <ActionForm action={removeStaff}>
                      <input type="hidden" name="id" value={p.id} />
                      <SubmitButton size="sm" variant="ghost">{t("Remove")}</SubmitButton>
                    </ActionForm>
                  )}
                </Td>
              </tr>
            ))}
          </Table>
        </Card>

        <Card>
          <CardHeader title={t("Add a colleague")} description={t("An existing account is promoted; otherwise we create one and email a link to choose the password.")} />
          <div className="p-5">
            <ActionForm action={addStaff}>
              <div className="grid gap-4 md:grid-cols-4">
                <Field label={t("Email")}><Input name="email" type="email" required /></Field>
                <Field label={t("First name")}><Input name="firstName" /></Field>
                <Field label={t("Last name")}><Input name="lastName" /></Field>
                <Field label={t("Role")}><Select name="role" defaultValue="support">{options}</Select></Field>
              </div>
              <ul className="space-y-1 text-xs text-muted">
                {STAFF_ROLES.map((r) => <li key={r}><strong className="font-medium">{t(STAFF_ROLE_LABEL[r])}</strong> — {t(STAFF_ROLE_HELP[r])}</li>)}
              </ul>
              <SubmitButton>{t("Add to staff")}</SubmitButton>
            </ActionForm>
          </div>
        </Card>
      </div>
    </>
  );
}
