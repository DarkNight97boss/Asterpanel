import { ActionForm, SubmitButton } from "@/components/action-form";
import { Card, Field, Input, PageHeader, Select, Textarea } from "@/components/ui";
import { getT } from "@/i18n";
import { openTicket } from "../../actions";

export default async function NewTicket() {
  const t = await getT();
  return (
    <>
      <PageHeader title={t("Open ticket")} />
      <Card className="max-w-2xl p-6">
        <ActionForm action={openTicket}>
          <Field label={t("Subject")}>
            <Input name="subject" required minLength={3} maxLength={200} />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t("Department")}>
              <Select name="department" defaultValue="support">
                <option value="support">{t("Technical support")}</option>
                <option value="billing">{t("Billing")}</option>
                <option value="sales">{t("Sales")}</option>
              </Select>
            </Field>
            <Field label={t("Priority")}>
              <Select name="priority" defaultValue="medium">
                <option value="low">{t("Low")}</option>
                <option value="medium">{t("Medium")}</option>
                <option value="high">{t("High")}</option>
              </Select>
            </Field>
          </div>
          <Field label={t("Message")}>
            <Textarea name="body" rows={8} required minLength={10} />
          </Field>
          <label className="block text-xs text-muted">{t("Attach files (up to 5, 5 MB each)")}<input type="file" name="files" multiple className="mt-1 block w-full text-sm file:mr-3 file:rounded-theme file:border file:border-border file:bg-surface file:px-3 file:py-1.5 file:text-sm" /></label>
          <SubmitButton>{t("Send")}</SubmitButton>
        </ActionForm>
      </Card>
    </>
  );
}
