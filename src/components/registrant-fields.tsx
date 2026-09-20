import { Field, Input, Select } from "@/components/ui";
import type { schema } from "@/db";
import { countryOptions, guessCountry } from "@/lib/countries";

type User = Pick<typeof schema.users.$inferSelect, "firstName" | "lastName" | "email" | "phone" | "address" | "city" | "zip" | "state" | "country">;
type Company = typeof schema.companies.$inferSelect | undefined;

/** The legal owner of a domain, pre-filled from the person and their company. Used wherever domains are ordered. */
export function RegistrantFields({ user, company: co, locale, t, requireTaxCode, itHint }: { user: User; company: Company; locale: string; t: (key: string) => string; requireTaxCode: boolean; itHint: boolean }) {
  const isCompany = co?.orgType === "company";
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <Field label={t("First name")}><Input name="firstName" required defaultValue={user.firstName} /></Field>
      <Field label={t("Last name")}><Input name="lastName" required defaultValue={user.lastName} /></Field>
      <Field label={t("Organization")} hint={t("Leave empty for a private person.")}><Input name="organization" defaultValue={isCompany ? co.billingName || co.name : ""} /></Field>
      <Field label={t("Tax code")} hint={itHint ? t("Required for .it: codice fiscale, or VAT number for organizations.") : undefined}><Input name="taxCode" required={requireTaxCode} defaultValue={(isCompany ? co?.vatId : co?.taxCode)?.replace(/[^a-z0-9]/gi, "") ?? ""} /></Field>
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
  );
}
