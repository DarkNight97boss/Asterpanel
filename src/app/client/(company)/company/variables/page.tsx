import { asc, eq } from "drizzle-orm";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { Card, CardHeader, Field, Input, PageHeader, Textarea } from "@/components/ui";
import { getDb, schema } from "@/db";
import { getT } from "@/i18n";
import { requireAccount } from "@/lib/account";
import { decryptJson } from "@/lib/crypto";
import { removeGroup, saveGroup } from "./actions";

export const metadata = { title: "Variable groups" };

export default async function VariableGroups() {
  const { account } = await requireAccount("manage");
  const [t, groups] = await Promise.all([getT(), (await getDb()).select().from(schema.envGroups).where(eq(schema.envGroups.companyId, account.id)).orderBy(asc(schema.envGroups.name))]);
  const text = (vars: string) => Object.entries(decryptJson<Record<string, string>>(vars, {})).map(([k, v]) => `${k}=${v}`).join("\n");
  const form = (g?: (typeof groups)[number]) => (
    <ActionForm action={saveGroup}>
      {g && <input type="hidden" name="groupId" value={g.id} />}
      <Field label={t("Name")}><Input name="name" required maxLength={60} defaultValue={g?.name} placeholder="production-database" /></Field>
      <Field label={t("Variables")} hint={t("One KEY=value per line. Encrypted at rest.")}><Textarea name="vars" rows={5} className="font-mono text-xs" defaultValue={g ? text(g.vars) : ""} placeholder={"DATABASE_URL=postgres://…\nREDIS_URL=redis://…"} /></Field>
      <SubmitButton variant={g ? "secondary" : "primary"}>{t("Save")}</SubmitButton>
    </ActionForm>
  );
  return (
    <>
      <PageHeader title={t("Variable groups")} description={t("Environment variables shared by several apps: change a value once, every app that uses the group gets it. Attach groups from each app's Settings.")} />
      <div className="space-y-6">
        {groups.map((g) => (
          <Card key={g.id}>
            <CardHeader title={g.name} action={<ActionForm action={removeGroup} className=""><input type="hidden" name="groupId" value={g.id} /><SubmitButton size="sm" variant="ghost">{t("Remove")}</SubmitButton></ActionForm>} />
            <div className="p-5 pt-0">{form(g)}</div>
          </Card>
        ))}
        <Card>
          <CardHeader title={t("New group")} />
          <div className="p-5 pt-0">{form()}</div>
        </Card>
      </div>
    </>
  );
}
