import { asc } from "drizzle-orm";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { Button, Card, CardHeader, Input, PageHeader } from "@/components/ui";
import { getDb, schema } from "@/db";
import { getT } from "@/i18n";
import { deleteMenuItem, saveMenuItem } from "../actions";

export default async function Menus() {
  const db = await getDb();
  const [t, all] = await Promise.all([getT(), db.select().from(schema.menuItems).orderBy(asc(schema.menuItems.position))]);
  const row = "grid items-center gap-2 space-y-0 sm:grid-cols-[1fr_1.4fr_5rem_auto]";

  return (
    <>
      <PageHeader title={t("Menus")} description={t("Links shown in the site header and footer.")} />
      <div className="space-y-6">
        {(["header", "footer"] as const).map((location) => (
          <Card key={location}>
            <CardHeader title={location === "header" ? t("Header menu") : t("Footer menu")} />
            <div className="space-y-3 p-5">
              {all.filter((m) => m.location === location).map((m) => (
                <div key={m.id} className="flex items-start gap-2">
                  <ActionForm action={saveMenuItem} className={`${row} flex-1`}>
                    <input type="hidden" name="id" value={m.id} />
                    <input type="hidden" name="location" value={location} />
                    <Input name="label" defaultValue={m.label} required aria-label={t("Label")} />
                    <Input name="href" defaultValue={m.href} required aria-label={t("Link")} />
                    <Input name="position" type="number" defaultValue={m.position} aria-label={t("Sort order")} />
                    <SubmitButton variant="secondary">{t("Save")}</SubmitButton>
                  </ActionForm>
                  <form action={deleteMenuItem}>
                    <input type="hidden" name="id" value={m.id} />
                    <Button variant="ghost" aria-label={t("Remove")}>✕</Button>
                  </form>
                </div>
              ))}
              <ActionForm action={saveMenuItem} className={`${row} border-t border-border pt-3`}>
                <input type="hidden" name="location" value={location} />
                <Input name="label" placeholder={t("Label")} required />
                <Input name="href" placeholder="/about-us" required />
                <Input name="position" type="number" defaultValue={all.length} aria-label={t("Sort order")} />
                <SubmitButton>{t("Add")}</SubmitButton>
              </ActionForm>
            </div>
          </Card>
        ))}
      </div>
    </>
  );
}
