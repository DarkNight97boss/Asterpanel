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
          <CardHeader title="Stripe" description={t("Cards, Google Pay and Apple Pay through Stripe Checkout. The wallets appear by themselves on devices that support them; switch them on or off under Payment methods in your Stripe dashboard.")} />
          <div className="space-y-4 p-5">
            <Checkbox name="stripeEnabled" defaultChecked={s.stripe.enabled} label={t("Enabled")} />
            <Field label={t("Secret key")}><Input name="stripeSecretKey" type="password" autoComplete="off" placeholder={kept(s.stripe.secretKey) || "sk_live_…"} /></Field>
            <Field label={t("Webhook signing secret")} hint={<>{t("Endpoint")}: <code>{origin}/api/webhooks/stripe</code> · {t("Events")}: <code>checkout.session.completed</code>, <code>payment_intent.succeeded</code></>}>
              <Input name="stripeWebhookSecret" type="password" autoComplete="off" placeholder={kept(s.stripe.webhookSecret) || "whsec_…"} />
            </Field>
            <Checkbox name="stripeSaveCards" defaultChecked={s.stripe.saveCards} label={t("Save the card after a payment and charge renewals on it automatically")} />
            <p className="text-xs text-muted">{t("A renewal is charged when its invoice is issued, then again after 3 and 5 days if the card is declined. Customers can remove their card or turn automatic payments off at any time.")}</p>
          </div>
        </Card>
        <Card>
          <CardHeader title="PayPal" description={t("Customers approve the payment on paypal.com and come back to their invoice.")} />
          <div className="space-y-4 p-5">
            <Checkbox name="paypalEnabled" defaultChecked={s.paypal.enabled} label={t("Enabled")} />
            <Field label="Client ID"><Input name="paypalClientId" defaultValue={s.paypal.clientId} autoComplete="off" /></Field>
            <Field label={t("Secret")}><Input name="paypalSecret" type="password" autoComplete="off" placeholder={kept(s.paypal.secret)} /></Field>
            <Field label="Webhook ID" hint={<>{t("Endpoint")}: <code>{origin}/api/webhooks/paypal</code> · {t("Event")}: <code>PAYMENT.CAPTURE.COMPLETED</code></>}><Input name="paypalWebhookId" defaultValue={s.paypal.webhookId} autoComplete="off" /></Field>
            <Checkbox name="paypalSandbox" defaultChecked={s.paypal.sandbox} label={t("Use the sandbox (no real money)")} />
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
