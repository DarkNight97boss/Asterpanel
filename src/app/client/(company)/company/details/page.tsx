import { eq } from "drizzle-orm";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { Card, CardHeader, Field, Input, PageHeader, Select } from "@/components/ui";
import { getDb, schema } from "@/db";
import { getT } from "@/i18n";
import { requireAccount } from "@/lib/account";
import { saveCompanyDetails, verifyVat } from "../actions";

export const metadata = { title: "Billing details" };

export default async function CompanyDetails() {
  const { account } = await requireAccount("billing");
  const [t, [co]] = await Promise.all([getT(), (await getDb()).select().from(schema.companies).where(eq(schema.companies.id, account.id))]);
  const f = (name: keyof typeof co, label: string, props: React.ComponentProps<typeof Input> = {}) => (
    <Field label={t(label)}><Input name={name} defaultValue={String(co[name] ?? "")} {...props} /></Field>
  );
  return (
    <>
      <PageHeader title={t("Billing details")} description={t("These details are printed on the invoices of {account}.", { account: account.name })} />
      <Card>
        <CardHeader title={t("Company details")} />
        <div className="p-6 pt-4">
          <ActionForm action={saveCompanyDetails}>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={t("Organization type")}>
                <Select name="orgType" defaultValue={co.orgType}>
                  <option value="company">{t("Company")}</option>
                  <option value="individual">{t("Individual")}</option>
                </Select>
              </Field>
              {f("name", "Company name", { required: true })}
              {f("taxCode", "Company ID / Tax code")}
              {f("billingName", "Billing name")}
              {f("country", "Country")}
              {f("state", "State / Province")}
              {f("city", "City")}
              {f("zip", "ZIP / Postal code")}
              {f("address1", "Address line 1")}
              {f("address2", "Address line 2")}
              {f("vatId", "VAT number")}
              {f("sdiCode", "SDI recipient code", { maxLength: 7, placeholder: "0000000" })}
              {f("pec", "Certified email (PEC)", { type: "email" })}
            </div>
            <SubmitButton>{t("Save")}</SubmitButton>
          </ActionForm>
          {co.vatId && (
            <div className="mt-6 flex flex-wrap items-center gap-3 border-t border-border pt-5 text-sm">
              {co.vatValidatedAt ? <span className="text-success">● {t("VAT number confirmed by VIES")}{co.vatValidatedName && ` — ${co.vatValidatedName}`}</span> : <span className="text-muted">{t("VAT number not verified. EU businesses outside our country get invoices without VAT once it is confirmed.")}</span>}
              <ActionForm action={verifyVat} className=""><SubmitButton size="sm" variant="secondary">{t("Verify with VIES")}</SubmitButton></ActionForm>
            </div>
          )}
        </div>
      </Card>
    </>
  );
}
