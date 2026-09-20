import { eq } from "drizzle-orm";
import { Alert, Badge, Button, Card, CardHeader, EmptyState, PageHeader, Table, Td } from "@/components/ui";
import { getDb, schema } from "@/db";
import { getLocale, getT } from "@/i18n";
import { formatMoney } from "@/lib/format";
import { requireAccount } from "@/lib/account";
import { listPaymentMethods } from "@/lib/payment-methods";
import { getSettings } from "@/lib/settings";
import { makeDefault, removeCard, setAutoPay } from "./actions";

export const metadata = { title: "Payment methods" };

export default async function PaymentMethods() {
  const { account } = await requireAccount("billing");
  const [t, locale, billing, gw, cards, [co]] = await Promise.all([getT(), getLocale(), getSettings("billing"), getSettings("gateways"), listPaymentMethods(account.id), (await getDb()).select().from(schema.companies).where(eq(schema.companies.id, account.id))]);
  const available = gw.stripe.enabled && gw.stripe.saveCards;

  return (
    <>
      <PageHeader title={t("Payment methods")} description={t("Cards saved for {account}. Card numbers are kept by our payment provider, never on our servers.", { account: account.name })} />
      <div className="space-y-6">
        {!available && <Alert tone="info">{t("Saved cards are not available at the moment. Invoices can be paid one by one from their page.")}</Alert>}
        {co.creditBalance > 0 && (
          <Card>
            <CardHeader title={t("Credit")} description={t("Spent automatically on your next invoices, before any card is charged.")} action={<span className="text-2xl">{formatMoney(co.creditBalance, billing.currency, locale)}</span>} />
          </Card>
        )}
        <Card>
          <CardHeader
            title={t("Automatic payments")}
            description={co.autoPay ? t("Renewal invoices are charged on the default card as soon as they are issued. You still get every invoice by email.") : t("Off: you pay every invoice yourself before its due date.")}
            action={<form action={setAutoPay}><input type="hidden" name="autoPay" value={co.autoPay ? "0" : "1"} /><Button variant="secondary">{co.autoPay ? t("Turn off") : t("Turn on")}</Button></form>}
          />
        </Card>
        <Card>
          {cards.length ? (
            <Table head={[t("Card"), t("Expires"), "", ""]}>
              {cards.map((c) => (
                <tr key={c.id}>
                  <Td className="font-medium capitalize">{c.brand === "sepa" ? t("SEPA direct debit") : c.brand} •••• {c.last4}</Td>
                  <Td className="text-body">{c.expYear ? `${String(c.expMonth).padStart(2, "0")}/${c.expYear}` : "—"}</Td>
                  <Td>{c.isDefault && <Badge tone="success">{t("Default")}</Badge>}</Td>
                  <Td className="text-right">
                    <div className="flex justify-end gap-1">
                      {!c.isDefault && <form action={makeDefault}><input type="hidden" name="id" value={c.id} /><Button size="sm" variant="ghost">{t("Make default")}</Button></form>}
                      <form action={removeCard}><input type="hidden" name="id" value={c.id} /><Button size="sm" variant="ghost">{t("Remove")}</Button></form>
                    </div>
                  </Td>
                </tr>
              ))}
            </Table>
          ) : (
            <EmptyState title={t("No saved cards")} description={t("Pay an invoice by card and it will be saved here for the next renewals.")} />
          )}
        </Card>
      </div>
    </>
  );
}
