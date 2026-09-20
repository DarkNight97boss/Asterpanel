import { asc, isNull } from "drizzle-orm";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { BlueprintForm } from "@/components/blueprint-form";
import { Card, CardHeader, PageHeader } from "@/components/ui";
import { getDb, schema } from "@/db";
import { getT } from "@/i18n";
import { requireArea } from "@/lib/auth";
import { removeShared, saveShared } from "./actions";

export const metadata = { title: "WordPress blueprints" };

export default async function SharedBlueprints() {
  await requireArea("platform");
  const [t, blueprints] = await Promise.all([getT(), (await getDb()).select().from(schema.wpBlueprints).where(isNull(schema.wpBlueprints.companyId)).orderBy(asc(schema.wpBlueprints.name))]);
  return (
    <>
      <PageHeader title={t("WordPress blueprints")} description={t("Ready-made starting points offered to every customer when they create a WordPress site. Customers can also keep their own.")} />
      <div className="space-y-6">
        {blueprints.map((b) => (
          <Card key={b.id}>
            <CardHeader title={b.name} action={<ActionForm action={removeShared} className=""><input type="hidden" name="blueprintId" value={b.id} /><SubmitButton size="sm" variant="ghost">{t("Remove")}</SubmitButton></ActionForm>} />
            <div className="p-5 pt-0"><BlueprintForm action={saveShared} blueprint={b} t={t} /></div>
          </Card>
        ))}
        <Card>
          <CardHeader title={t("New blueprint")} />
          <div className="p-5 pt-0"><BlueprintForm action={saveShared} t={t} /></div>
        </Card>
      </div>
    </>
  );
}
