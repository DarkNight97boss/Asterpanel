import { eq } from "drizzle-orm";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { RegistrantFields } from "@/components/registrant-fields";
import { Alert, Button, ButtonLink, Card, CardHeader, EmptyState, Field, Input, PageHeader, Table, Td } from "@/components/ui";
import { getDb, schema } from "@/db";
import { getLocale, getT } from "@/i18n";
import { requireAccount } from "@/lib/account";
import { viewCart } from "@/lib/cart";
import { formatMoney } from "@/lib/format";
import { getSettings } from "@/lib/settings";
import { checkout, removeItem } from "./actions";

export const metadata = { title: "Cart" };

export default async function Cart({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { user, account } = await requireAccount("manage");
  const [t, locale, billing, cart, [co], { error }] = await Promise.all([getT(), getLocale(), getSettings("billing"), viewCart(account.id, account.ownerUserId), (await getDb()).select().from(schema.companies).where(eq(schema.companies.id, account.id)), searchParams]);
  const money = (c: number) => formatMoney(c, billing.currency, locale);
  const broken = cart.items.some((i) => i.error);

  return (
    <>
      <PageHeader title={t("Cart")} description={t("Everything here is ordered together, on one invoice.")} action={<div className="flex gap-2"><ButtonLink href="/client/domains/new" variant="secondary">{t("Add domain")}</ButtonLink><ButtonLink href="/#plans" variant="secondary">{t("Browse plans")}</ButtonLink></div>} />
      {error && <div className="mb-6"><Alert tone="danger">{t(error)}</Alert></div>}
      {!cart.items.length ? (
        <Card><EmptyState title={t("Your cart is empty")} description={t("Add a hosting plan or a domain, then pay for everything at once.")} /></Card>
      ) : (
        <div className="max-w-3xl space-y-6">
          <Card>
            <Table head={[t("Item"), t("Today"), t("Then"), ""]}>
              {cart.items.map((i) => (
                <tr key={i.id}>
                  <Td><span className="font-medium">{i.label}</span>{i.error && <span className="mt-0.5 block text-xs text-danger">{t(i.error)}</span>}</Td>
                  <Td>{i.error ? "—" : <>{money(i.price)}{i.setup > 0 && <span className="block text-xs text-muted">+ {money(i.setup)} {t("Setup fee")}</span>}</>}</Td>
                  <Td className="text-body">{i.error ? "—" : money(i.recurring)}</Td>
                  <Td className="text-right"><form action={removeItem}><input type="hidden" name="id" value={i.id} /><Button size="sm" variant="ghost">{t("Remove")}</Button></form></Td>
                </tr>
              ))}
            </Table>
            <p className="flex justify-between border-t border-border px-5 py-4 text-sm"><span className="text-muted">{t("Subtotal, before taxes and discounts")}</span><span className="font-semibold">{money(cart.subtotal)}</span></p>
          </Card>
          {broken ? <Alert tone="warning">{t("Remove the items that can no longer be ordered to continue.")}</Alert> : (
            <Card>
              <CardHeader title={t("Checkout")} description={cart.hasDomains ? t("The registrant is the legal owner of the domains in the cart. These details are sent to the registry, so they must be real and complete.") : undefined} />
              <div className="p-5 pt-0">
                <ActionForm action={checkout}>
                  {cart.hasDomains && <RegistrantFields user={user} company={co} locale={locale} t={t} requireTaxCode={cart.tlds.includes("it")} itHint={cart.tlds.includes("it")} />}
                  <Field label={t("Discount code")} className="max-w-xs"><Input name="coupon" maxLength={40} autoComplete="off" className="uppercase" /></Field>
                  <SubmitButton size="lg">{t("Continue to payment")}</SubmitButton>
                </ActionForm>
              </div>
            </Card>
          )}
        </div>
      )}
    </>
  );
}
