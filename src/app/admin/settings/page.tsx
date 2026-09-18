import { ActionForm, SubmitButton } from "@/components/action-form";
import { Card, Checkbox, Field, Input, PageHeader, Select, Textarea } from "@/components/ui";
import { getT } from "@/i18n";
import { LOCALES } from "@/i18n/shared";
import { requireAdmin } from "@/lib/auth";
import { getSettings } from "@/lib/settings";
import { saveGeneral } from "../actions";

export default async function GeneralSettings() {
  await requireAdmin();
  const [t, s] = await Promise.all([getT(), getSettings("general")]);
  return (
    <>
      <PageHeader title={t("Settings")} />
      <Card className="max-w-2xl p-5">
        <ActionForm action={saveGeneral}>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t("Site name")}><Input name="siteName" defaultValue={s.siteName} required /></Field>
            <Field label={t("Language")}>
              <Select name="locale" defaultValue={s.locale}>
                {Object.entries(LOCALES).map(([code, name]) => <option key={code} value={code}>{name}</option>)}
              </Select>
            </Field>
            <Field label={t("Tagline")} className="sm:col-span-2"><Input name="tagline" defaultValue={s.tagline} /></Field>
            <Field label={t("Support email")}><Input name="supportEmail" type="email" defaultValue={s.supportEmail} /></Field>
            <Field label={t("Company name")}><Input name="companyName" defaultValue={s.companyName} /></Field>
            <Field label={t("Company VAT ID")}><Input name="companyVatId" defaultValue={s.companyVatId} /></Field>
            <Field label={t("Company address")} hint={t("Shown on invoices.")} className="sm:col-span-2">
              <Textarea name="companyAddress" defaultValue={s.companyAddress} rows={3} />
            </Field>
          </div>
          <Checkbox name="allowRegistration" defaultChecked={s.allowRegistration} label={t("Allow new client registrations")} />
          <SubmitButton>{t("Save")}</SubmitButton>
        </ActionForm>
      </Card>
    </>
  );
}
