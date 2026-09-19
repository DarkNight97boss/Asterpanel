import { ActionForm, SubmitButton } from "@/components/action-form";
import { Card, Field, Input, PageHeader, Select } from "@/components/ui";
import { getT } from "@/i18n";
import { requireUser } from "@/lib/auth";
import { newCompany } from "../actions";

export const metadata = { title: "Create new company" };

export default async function NewCompany() {
  await requireUser();
  const t = await getT();
  return (
    <>
      <PageHeader title={t("Create new company")} description={t("A company has its own services, invoices and users. You become its owner and can switch between your companies from the top bar.")} />
      <Card className="max-w-xl p-6">
        <ActionForm action={newCompany}>
          <Field label={t("Company name")}><Input name="name" required maxLength={120} /></Field>
          <Field label={t("Organization type")}>
            <Select name="orgType" defaultValue="company">
              <option value="company">{t("Company")}</option>
              <option value="individual">{t("Individual")}</option>
            </Select>
          </Field>
          <SubmitButton>{t("Create company")}</SubmitButton>
        </ActionForm>
      </Card>
    </>
  );
}
