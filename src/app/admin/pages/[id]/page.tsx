import { notFound } from "next/navigation";
import { asc, eq } from "drizzle-orm";
import { BlockEditor } from "@/cms/block-editor";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { Button, ButtonLink, Card, CardHeader, Field, Input, PageHeader, Select, Textarea } from "@/components/ui";
import { getDb, schema } from "@/db";
import { getT } from "@/i18n";
import { deletePage, savePage } from "../../actions";

export default async function PageEditor({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const isNew = id === "new";
  if (!isNew && !/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const db = await getDb();
  const [page, groups, t] = await Promise.all([
    isNew ? undefined : db.query.pages.findFirst({ where: eq(schema.pages.id, id) }),
    db.select({ id: schema.productGroups.id, name: schema.productGroups.name }).from(schema.productGroups).orderBy(asc(schema.productGroups.position)),
    getT(),
  ]);
  if (!isNew && !page) notFound();

  return (
    <>
      <PageHeader
        title={page?.title ?? t("New page")}
        action={page?.status === "published" && <ButtonLink href={`/${page.slug}`} target="_blank" variant="secondary">{t("View page")} ↗</ButtonLink>}
      />
      <ActionForm action={savePage} className="grid items-start gap-6 xl:grid-cols-[1fr_20rem]">
        <input type="hidden" name="id" value={page?.id ?? ""} />
        <div className="xl:order-2 xl:sticky xl:top-6">
          <Card>
            <CardHeader title={t("Page settings")} />
            <div className="space-y-4 p-5">
              <Field label={t("Title")}><Input name="title" defaultValue={page?.title} required /></Field>
              <Field label={t("URL slug")} hint={t("Leave empty for the home page.")}><Input name="slug" defaultValue={page?.slug} placeholder="about-us" /></Field>
              <Field label={t("Status")}>
                <Select name="status" defaultValue={page?.status ?? "draft"}>
                  <option value="draft">{t("Draft")}</option>
                  <option value="published">{t("Published")}</option>
                </Select>
              </Field>
              <Field label={t("SEO title")}><Input name="seoTitle" defaultValue={page?.seoTitle} /></Field>
              <Field label={t("SEO description")}><Textarea name="seoDescription" defaultValue={page?.seoDescription} rows={3} /></Field>
              <SubmitButton className="w-full">{t("Save")}</SubmitButton>
            </div>
          </Card>
        </div>
        <div className="min-w-0 xl:order-1">
          <BlockEditor initial={page?.blocks ?? []} groups={groups} />
        </div>
      </ActionForm>

      {page && (
        <form action={deletePage} className="mt-10 border-t border-border pt-6">
          <input type="hidden" name="id" value={page.id} />
          <Button variant="ghost">{t("Delete page")}</Button>
        </form>
      )}
    </>
  );
}
