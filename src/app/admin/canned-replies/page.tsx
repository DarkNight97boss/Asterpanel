import { asc } from "drizzle-orm";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { Button, Card, CardHeader, EmptyState, Field, Input, PageHeader, Textarea } from "@/components/ui";
import { getDb, schema } from "@/db";
import { getT } from "@/i18n";
import { requireArea } from "@/lib/auth";
import { deleteCannedReply, saveCannedReply } from "../extras-actions";

export const metadata = { title: "Canned replies" };

export default async function CannedReplies() {
  await requireArea("support");
  const [t, rows] = await Promise.all([getT(), (await getDb()).select().from(schema.cannedReplies).orderBy(asc(schema.cannedReplies.title))]);
  return (
    <>
      <PageHeader title={t("Canned replies")} description={t("Answers to the questions you get every week. Insert one in a ticket reply and adapt it.")} />
      <div className="space-y-6">
        <Card>
          {rows.length ? (
            <ul className="divide-y divide-border">
              {rows.map((r) => (
                <li key={r.id} className="flex items-start justify-between gap-4 px-5 py-4">
                  <div className="min-w-0"><p className="font-medium">{r.title}</p><p className="mt-1 line-clamp-2 text-sm whitespace-pre-line text-body">{r.body}</p></div>
                  <form action={deleteCannedReply}><input type="hidden" name="id" value={r.id} /><Button size="sm" variant="ghost">{t("Remove")}</Button></form>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState title={t("Nothing here yet")} />
          )}
        </Card>
        <Card>
          <CardHeader title={t("New reply")} />
          <div className="p-5">
            <ActionForm action={saveCannedReply}>
              <Field label={t("Title")}><Input name="title" required maxLength={80} /></Field>
              <Field label={t("Text")}><Textarea name="body" rows={6} required /></Field>
              <SubmitButton>{t("Save")}</SubmitButton>
            </ActionForm>
          </div>
        </Card>
      </div>
    </>
  );
}
