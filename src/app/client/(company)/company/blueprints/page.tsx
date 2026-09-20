import { ActionForm, SubmitButton } from "@/components/action-form";
import { BlueprintForm } from "@/components/blueprint-form";
import { Badge, Card, CardHeader, PageHeader } from "@/components/ui";
import { getT } from "@/i18n";
import { requireAccount } from "@/lib/account";
import { listBlueprints } from "@/platform/engine";
import { removeBlueprint, saveBlueprintAction } from "./actions";

export const metadata = { title: "WordPress blueprints" };

export default async function Blueprints() {
  const { account } = await requireAccount("manage");
  const [t, all] = await Promise.all([getT(), listBlueprints(account.id)]);
  const mine = all.filter((b) => b.companyId);
  const shared = all.filter((b) => !b.companyId);
  const form = (b?: (typeof all)[number]) => <BlueprintForm action={saveBlueprintAction} blueprint={b} t={t} />;
  return (
    <>
      <PageHeader title={t("WordPress blueprints")} description={t("Starting points for new sites: the plugins, theme and settings you always begin with. Choose one when you create a WordPress site; sites that already exist are not touched.")} />
      <div className="space-y-6">
        {shared.length > 0 && (
          <Card>
            <CardHeader title={t("Ready-made")} description={t("Offered by your hosting provider.")} />
            <ul className="divide-y divide-border">
              {shared.map((b) => (
                <li key={b.id} className="flex flex-wrap items-center gap-2 px-5 py-3 text-sm"><span className="font-semibold">{b.name}</span>{b.spec.theme && <Badge>{b.spec.theme}</Badge>}<span className="text-muted">{b.spec.plugins.join(", ")}</span></li>
              ))}
            </ul>
          </Card>
        )}
        {mine.map((b) => (
          <Card key={b.id}>
            <CardHeader title={b.name} action={<ActionForm action={removeBlueprint} className=""><input type="hidden" name="blueprintId" value={b.id} /><SubmitButton size="sm" variant="ghost">{t("Remove")}</SubmitButton></ActionForm>} />
            <div className="p-5 pt-0">{form(b)}</div>
          </Card>
        ))}
        <Card>
          <CardHeader title={t("New blueprint")} />
          <div className="p-5 pt-0">{form()}</div>
        </Card>
      </div>
    </>
  );
}
