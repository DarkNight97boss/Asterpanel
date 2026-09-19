import Link from "next/link";
import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { Card, CardHeader, Checkbox, Field, Input, PageHeader, Textarea } from "@/components/ui";
import { getDb, schema } from "@/db";
import { getT } from "@/i18n";
import { requireAdmin } from "@/lib/auth";
import { templateDef } from "@/lib/mail/templates";
import { resetEmailTemplate, saveEmailTemplate } from "../../../../actions";

export default async function EmailTemplateEditor({ params }: { params: Promise<{ id: string }> }) {
  await requireAdmin();
  const def = templateDef(decodeURIComponent((await params).id));
  if (!def) notFound();
  const db = await getDb();
  const [t, override] = await Promise.all([getT(), db.query.emailTemplates.findFirst({ where: eq(schema.emailTemplates.id, def.id) })]);

  return (
    <>
      <PageHeader
        title={t(def.name)}
        description={t(def.description)}
        action={<Link href="/admin/settings/mail/templates" className="text-sm text-link">← {t("Email templates")}</Link>}
      />
      <div className="grid items-start gap-6 xl:grid-cols-2">
        <div className="space-y-6">
          <Card>
            <CardHeader title={t("Wording")} description={t("Leave a field empty to use the built-in text in your site language.")} />
            <div className="p-5">
              <ActionForm action={saveEmailTemplate}>
                <input type="hidden" name="id" value={def.id} />
                <Checkbox name="enabled" defaultChecked={override?.enabled ?? true} label={t("Send this email")} />
                <Field label={t("Subject")}><Input name="subject" defaultValue={override?.subject} placeholder={t(def.subject)} maxLength={200} /></Field>
                <Field label={t("Heading")}><Input name="heading" defaultValue={override?.heading} placeholder={t(def.heading)} maxLength={200} /></Field>
                <Field label={t("Text")} hint={t("Separate paragraphs with an empty line.")}>
                  <Textarea name="body" rows={8} defaultValue={override?.body} placeholder={def.body.map((p) => t(p)).join("\n\n")} maxLength={5000} />
                </Field>
                <SubmitButton>{t("Save")}</SubmitButton>
              </ActionForm>
            </div>
          </Card>
          <Card>
            <CardHeader title={t("Variables")} description={t("Replaced with real values when the email is sent.")} />
            <dl className="divide-y divide-border text-sm">
              {Object.entries(def.variables).map(([key, label]) => (
                <div key={key} className="flex items-center justify-between gap-4 px-5 py-2.5">
                  <dt><code className="rounded bg-subtle px-1.5 py-0.5 font-mono text-xs">{`{${key}}`}</code></dt>
                  <dd className="text-muted">{t(label)}</dd>
                </div>
              ))}
            </dl>
          </Card>
          {override && (
            <form action={resetEmailTemplate}>
              <input type="hidden" name="id" value={def.id} />
              <button className="cursor-pointer text-sm text-muted hover:text-danger">{t("Restore the default template")}</button>
            </form>
          )}
        </div>

        <Card className="overflow-hidden xl:sticky xl:top-6">
          <CardHeader title={t("Preview")} description={t("Saved version, with sample data.")} />
          <iframe
            key={override?.updatedAt.getTime() ?? 0}
            src={`/admin/settings/mail/templates/${def.id}/preview?v=${override?.updatedAt.getTime() ?? 0}`}
            title={t("Preview")}
            className="h-[38rem] w-full bg-white"
          />
        </Card>
      </div>
    </>
  );
}
