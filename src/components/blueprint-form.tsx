import { ActionForm, SubmitButton, type FormAction } from "@/components/action-form";
import { Checkbox, Field, Input, Select, Textarea } from "@/components/ui";
import type { WpBlueprint } from "@/db/schema";
import { PERMALINKS } from "@/platform/blueprints";

/** One blueprint, new or existing: shared by customers (their company's) and staff (the ones offered to everybody). */
export function BlueprintForm({ action, blueprint: b, t }: { action: FormAction; blueprint?: { id: string; name: string; spec: WpBlueprint }; t: (key: string) => string }) {
  return (
    <ActionForm action={action}>
      {b && <input type="hidden" name="blueprintId" value={b.id} />}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t("Name")}><Input name="name" required maxLength={60} defaultValue={b?.name} placeholder="Agency starter" /></Field>
        <Field label={t("Theme")} hint={t("A wordpress.org slug. Empty = the default theme.")}><Input name="theme" defaultValue={b?.spec.theme ?? ""} placeholder="astra" /></Field>
        <Field label={t("Plugins")} hint={t("wordpress.org slugs or links, one per line. Installed and activated.")} className="sm:col-span-2"><Textarea name="plugins" rows={4} className="font-mono text-xs" spellCheck={false} defaultValue={b?.spec.plugins.join("\n") ?? ""} placeholder={"wordpress-seo\ncontact-form-7"} /></Field>
        <Field label={t("Permalinks")}>
          <Select name="permalinks" defaultValue={b?.spec.permalinks ?? ""}>
            <option value="">{t("WordPress default")}</option>
            {PERMALINKS.map((p) => <option key={p} value={p}>{p}</option>)}
          </Select>
        </Field>
        <Field label={t("Time zone")}><Input name="timezone" defaultValue={b?.spec.timezone ?? ""} placeholder="Europe/Rome" /></Field>
      </div>
      <Checkbox name="hideFromSearch" defaultChecked={b?.spec.hideFromSearch} label={t("Ask search engines not to index the site (for sites under construction)")} />
      <SubmitButton variant={b ? "secondary" : "primary"}>{t("Save")}</SubmitButton>
    </ActionForm>
  );
}
