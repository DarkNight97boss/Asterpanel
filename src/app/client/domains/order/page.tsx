import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { Alert, Card, CardHeader, Field, Input, PageHeader, Select, Textarea } from "@/components/ui";
import { getDb, schema } from "@/db";
import { getLocale, getT } from "@/i18n";
import { requireAccount } from "@/lib/account";
import { countryOptions, guessCountry } from "@/lib/countries";
import { firstYearPrice, MAX_BASKET, MAX_YEARS, splitDomain } from "@/lib/domains";
import { formatMoney } from "@/lib/format";
import { getSettings } from "@/lib/settings";
import { order } from "../actions";

export const metadata = { title: "Add domain" };

export default async function OrderDomain({ searchParams }: { searchParams: Promise<{ domain?: string | string[]; action?: string; bulk?: string }> }) {
  const { user, account } = await requireAccount("manage");
  const sp = await searchParams;
  const db = await getDb();
  const [t, locale, billing, tlds, [co]] = await Promise.all([getT(), getLocale(), getSettings("billing"), db.select().from(schema.domainTlds).where(eq(schema.domainTlds.enabled, true)), db.select().from(schema.companies).where(eq(schema.companies.id, account.id))]);
  const bulk = sp.bulk === "1";
  const known = tlds.map((x) => x.tld);
  const wanted = [...new Set([sp.domain ?? []].flat())].slice(0, MAX_BASKET).map((d) => splitDomain(d, known)).filter((p) => !!p);
  if (!bulk && !wanted.length) redirect("/client/domains/new");
  const parts = wanted[0] ?? { name: "", tld: "" };
  const many = wanted.length > 1;
  const tldOf = (x: string) => tlds.find((y) => y.tld === x)!;
  const transfer = sp.action === "transfer" && !many && !bulk;
  const price = wanted.reduce((sum, p) => sum + (transfer ? tldOf(p.tld).transferPrice : firstYearPrice(tldOf(p.tld))), 0);
  const renew = wanted.reduce((sum, p) => sum + tldOf(p.tld).renewPrice, 0);
  const needsIt = bulk || wanted.some((p) => p.tld === "it");
  const money = (c: number) => formatMoney(c, billing.currency, locale);
  const isCompany = co?.orgType === "company";

  return (
    <>
      <PageHeader
        title={bulk ? t("Bulk transfer") : many ? t("Register {n} domains", { n: wanted.length }) : transfer ? t("Transfer {domain}", { domain: parts.name }) : t("Register {domain}", { domain: parts.name })}
        description={bulk ? t("Move several domains here at once: one invoice, one registrant. Each transfer costs the transfer price of its extension and adds a year.") : t("{price} for the first year, then {renew} per year. Taxes are added on the invoice.", { price: money(price), renew: money(renew) })}
      />
      {many && (
        <Card className="mb-6 max-w-3xl">
          <ul className="divide-y divide-border text-sm">
            {wanted.map((p) => <li key={p.name} className="flex justify-between gap-3 px-5 py-2.5"><span className="font-medium">{p.name}</span><span className="text-body">{money(firstYearPrice(tldOf(p.tld)))}</span></li>)}
          </ul>
        </Card>
      )}
      <Card className="max-w-3xl">
        <CardHeader title={t("Registrant")} description={t("The legal owner of the domain. These details are sent to the registry, so they must be real and complete.")} />
        <div className="p-5">
          <ActionForm action={order}>
            {wanted.map((p) => <input key={p.name} type="hidden" name="domain" value={p.name} />)}
            {bulk && (
              <>
                <Alert tone="info">{t("Before you start: unlock the domain at your current registrar and ask them for the transfer (EPP / auth) code. A transfer usually takes 5 to 7 days and adds one year to the expiry date.")}</Alert>
                <Field label={t("Domains and transfer codes")} hint={t("One per line: the domain, a space, its transfer code. Up to {n}.", { n: MAX_BASKET })}><Textarea name="transfers" required rows={8} className="font-mono text-xs" spellCheck={false} autoComplete="off" placeholder={"example.com  Xy7#kd92\nexample.it  aB3$mn55"} /></Field>
              </>
            )}
            <input type="hidden" name="action" value={transfer ? "transfer" : "register"} />
            {transfer && (
              <>
                <Alert tone="info">{t("Before you start: unlock the domain at your current registrar and ask them for the transfer (EPP / auth) code. A transfer usually takes 5 to 7 days and adds one year to the expiry date.")}</Alert>
                <Field label={t("Transfer code")}><Input name="authCode" required autoComplete="off" maxLength={100} /></Field>
              </>
            )}
            {!transfer && !bulk && (
              <Field label={t("Register for")} className="max-w-xs">
                <Select name="years" defaultValue="1">
                  {Array.from({ length: MAX_YEARS }, (_, i) => i + 1).map((y) => <option key={y} value={y}>{y === 1 ? t("1 year") : t("{n} years", { n: y })} — {money(price + (y - 1) * renew)}</option>)}
                </Select>
              </Field>
            )}
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={t("First name")}><Input name="firstName" required defaultValue={user.firstName} /></Field>
              <Field label={t("Last name")}><Input name="lastName" required defaultValue={user.lastName} /></Field>
              <Field label={t("Organization")} hint={t("Leave empty for a private person.")}><Input name="organization" defaultValue={isCompany ? co.billingName || co.name : ""} /></Field>
              <Field label={t("Tax code")} hint={needsIt ? t("Required for .it: codice fiscale, or VAT number for organizations.") : undefined}><Input name="taxCode" required={needsIt && !bulk} defaultValue={(isCompany ? co?.vatId : co?.taxCode)?.replace(/[^a-z0-9]/gi, "") ?? ""} /></Field>
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
            <SubmitButton>{t("Continue to payment")}</SubmitButton>
          </ActionForm>
        </div>
      </Card>
    </>
  );
}
