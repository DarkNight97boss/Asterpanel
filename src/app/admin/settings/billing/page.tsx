import { ActionForm, SubmitButton } from "@/components/action-form";
import { Card, Field, Input, PageHeader, Textarea } from "@/components/ui";
import { getT } from "@/i18n";
import { requireAdmin } from "@/lib/auth";
import { getSettings } from "@/lib/settings";
import { saveBilling } from "../../actions";

export default async function BillingSettings() {
  await requireAdmin();
  const [t, s] = await Promise.all([getT(), getSettings("billing")]);
  return (
    <>
      <PageHeader title={t("Billing")} />
      <Card className="max-w-2xl p-5">
        <ActionForm action={saveBilling}>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t("Currency")} hint="ISO 4217"><Input name="currency" defaultValue={s.currency} maxLength={3} required /></Field>
            <Field label={t("Invoice prefix")}><Input name="invoicePrefix" defaultValue={s.invoicePrefix} maxLength={10} /></Field>
            <Field label={t("Tax name")}><Input name="taxName" defaultValue={s.taxName} /></Field>
            <Field label={t("Tax rate (%)")}><Input name="taxPercent" inputMode="decimal" defaultValue={s.taxRate / 100} /></Field>
            <Field label={t("Invoice renewals (days before due)")}><Input name="invoiceDaysBeforeDue" type="number" min={0} max={60} defaultValue={s.invoiceDaysBeforeDue} /></Field>
            <Field label={t("Suspend (days after due)")}><Input name="suspendDaysAfterDue" type="number" min={0} max={90} defaultValue={s.suspendDaysAfterDue} /></Field>
            <Field label={t("Overdue reminders (days after due)")} hint={t("Comma separated. Leave empty to disable.")}>
              <Input name="overdueReminderDays" defaultValue={s.overdueReminderDays.join(", ")} placeholder="3, 7, 14" />
            </Field>
            <Field label={t("Terminate (days after due)")} hint={t("0 = never")}><Input name="terminateDaysAfterDue" type="number" min={0} max={365} defaultValue={s.terminateDaysAfterDue} /></Field>
          </div>
          <Field label={t("Bank transfer instructions")} hint={t("Shown to clients who choose to pay by bank transfer.")}>
            <Textarea name="bankTransferInstructions" defaultValue={s.bankTransferInstructions} rows={4} />
          </Field>
          <SubmitButton>{t("Save")}</SubmitButton>
        </ActionForm>
      </Card>
    </>
  );
}
