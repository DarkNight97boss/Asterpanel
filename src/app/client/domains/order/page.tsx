import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { Alert, Card, CardHeader, Field, Input, PageHeader, Select } from "@/components/ui";
import { getDb, schema } from "@/db";
import { getLocale, getT } from "@/i18n";
import { requireAccount } from "@/lib/account";
import { countryOptions, guessCountry } from "@/lib/countries";
import { splitDomain } from "@/lib/domains";
import { formatMoney } from "@/lib/format";
import { getSettings } from "@/lib/settings";
import { order } from "../actions";

export const metadata = { title: "Add domain" };

export default async function OrderDomain({ searchParams }: { searchParams: Promise<{ domain?: string; action?: string }> }) {
  const { user, account } = await requireAccount("manage");
  const sp = await searchParams;
  const db = await getDb();
  const [t, locale, billing, tlds, [co]] = await Promise.all([getT(), getLocale(), getSettings("billing"), db.select().from(schema.domainTlds).where(eq(schema.domainTlds.enabled, true)), db.select().from(schema.companies).where(eq(schema.companies.id, account.id))]);
  const parts = splitDomain(sp.domain ?? "", tlds.map((x) => x.tld));
  if (!parts) redirect("/client/domains/new");
  const tld = tlds.find((x) => x.tld === parts.tld)!;
  const transfer = sp.action === "transfer";
  const price = transfer ? tld.transferPrice : tld.registerPrice;
  const money = (c: number) => formatMoney(c, billing.currency, locale);
  const isCompany = co?.orgType === "company";

  return (
    <>
      <PageHeader title={transfer ? t("Transfer {domain}", { domain: parts.name }) : t("Register {domain}", { domain: parts.name })} description={t("{price} for the first year, then {renew} per year. Taxes are added on the invoice.", { price: money(price), renew: money(tld.renewPrice) })} />
      <Card className="max-w-3xl">
        <CardHeader title={t("Registrant")} description={t("The legal owner of the domain. These details are sent to the registry, so they must be real and complete.")} />
        <div className="p-5">
          <ActionForm action={order}>
            <input type="hidden" name="domain" value={parts.name} />
            <input type="hidden" name="action" value={transfer ? "transfer" : "register"} />
            {transfer && (
              <>
                <Alert tone="info">{t("Before you start: unlock the domain at your current registrar and ask them for the transfer (EPP / auth) code. A transfer usually takes 5 to 7 days and adds one year to the expiry date.")}</Alert>
                <Field label={t("Transfer code")}><Input name="authCode" required autoComplete="off" maxLength={100} /></Field>
              </>
            )}
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={t("First name")}><Input name="firstName" required defaultValue={user.firstName} /></Field>
              <Field label={t("Last name")}><Input name="lastName" required defaultValue={user.lastName} /></Field>
              <Field label={t("Organization")} hint={t("Leave empty for a private person.")}><Input name="organization" defaultValue={isCompany ? co.billingName || co.name : ""} /></Field>
              <Field label={t("Tax code")} hint={parts.tld === "it" ? t("Required for .it: codice fiscale, or VAT number for organizations.") : undefined}><Input name="taxCode" required={parts.tld === "it"} defaultValue={(isCompany ? co?.vatId : co?.taxCode)?.replace(/[^a-z0-9]/gi, "") ?? ""} /></Field>
              <Field label={t("Email")}><Input name="email" type="email" required defaultValue={user.email} /></Field>
              <Field label={t("Phone")} hint="+39 06 1234567"><Input name="phone" type="tel" required defaultValue={user.phone} /></Field>
              <Field label={t("Address")} className="sm:col-span-2"><Input name="address" required defaultValue={co?.address1 || user.address} /></Field>
              <Field label={t("City")}><Input name="city" required defaultValue={co?.city || user.city} /></Field>
              <Field label={t("ZIP / Postal code")}><Input name="zip" required defaultValue={co?.zip || user.zip} /></Field>
              <Field label={t("State / Province")}><Input name="state" defaultValue={co?.state || user.state} /></Field>
              <Field label={t("Country")}>
                <Select name="country" required defaultValue={guessCountry(co?.country || user.country, locale)}>
                  <option value="">—</option>
                  {countryOptions(locale).map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}
                </Select>
              </Field>
            </div>
            <SubmitButton>{t("Continue to payment")} — {money(price)}</SubmitButton>
          </ActionForm>
        </div>
      </Card>
    </>
  );
}
