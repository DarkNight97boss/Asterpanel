import { ActionForm, SubmitButton } from "@/components/action-form";
import { Card, CardHeader, Checkbox, Field, Input, PageHeader } from "@/components/ui";
import { getT } from "@/i18n";
import { requireAdmin } from "@/lib/auth";
import { getSettings } from "@/lib/settings";
import { baseUrl } from "@/lib/url";
import { saveGateways } from "../../actions";

export default async function Gateways() {
  await requireAdmin();
  const [t, s, origin] = await Promise.all([getT(), getSettings("gateways"), baseUrl()]);
  const kept = (value: string) => (value ? "••••••••  (unchanged)" : "");
  return (
    <>
      <PageHeader title={t("Payment gateways")} description={t("API keys are encrypted at rest and never shown again.")} />
      <ActionForm action={saveGateways} className="max-w-2xl space-y-6">
        <Card>
          <CardHeader title="Stripe" description={t("Cards, wallets and local methods through Stripe Checkout.")} />
          <div className="space-y-4 p-5">
            <Checkbox name="stripeEnabled" defaultChecked={s.stripe.enabled} label={t("Enabled")} />
            <Field label={t("Secret key")}><Input name="stripeSecretKey" type="password" autoComplete="off" placeholder={kept(s.stripe.secretKey) || "sk_live_…"} /></Field>
            <Field label={t("Webhook signing secret")} hint={<>{t("Endpoint")}: <code>{origin}/api/webhooks/stripe</code> · {t("Event")}: <code>checkout.session.completed</code></>}>
              <Input name="stripeWebhookSecret" type="password" autoComplete="off" placeholder={kept(s.stripe.webhookSecret) || "whsec_…"} />
            </Field>
          </div>
        </Card>
        <Card>
          <CardHeader title={t("Bank transfer")} description={t("Offline payment. Staff records the payment on the invoice.")} />
          <div className="p-5">
            <Checkbox name="bankTransferEnabled" defaultChecked={s.bankTransfer.enabled} label={t("Enabled")} />
          </div>
        </Card>
        <SubmitButton>{t("Save")}</SubmitButton>
      </ActionForm>
    </>
  );
}
