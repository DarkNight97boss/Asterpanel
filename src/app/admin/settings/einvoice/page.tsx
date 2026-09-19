import { ActionForm, SubmitButton } from "@/components/action-form";
import { Alert, Card, CardHeader, Checkbox, Field, Input, PageHeader, Select } from "@/components/ui";
import { getT } from "@/i18n";
import { requireAdmin } from "@/lib/auth";
import { getSettings } from "@/lib/settings";
import { sdiProviders } from "@/modules/sdi";
import { saveEinvoice, saveSdi } from "../../platform-actions";

export const metadata = { title: "Electronic invoicing" };

const REGIMES: [string, string][] = [["RF01", "RF01 — Ordinario"], ["RF19", "RF19 — Forfettario"], ["RF02", "RF02 — Contribuenti minimi"], ["RF18", "RF18 — Altro"]];
const NATURES = ["N1", "N2.1", "N2.2", "N3.2", "N3.3", "N4", "N6.9", "N7"];

export default async function EinvoiceSettings() {
  await requireAdmin();
  const [t, s, billing, sdi] = await Promise.all([getT(), getSettings("einvoice"), getSettings("billing"), getSettings("sdi")]);
  return (
    <>
      <PageHeader title={t("Electronic invoicing")} description={t("Italian FatturaPA: every invoice can be downloaded as the XML file the Sistema di Interscambio accepts.")} />
      <div className="max-w-3xl space-y-6">
        {billing.currency !== "EUR" && <Alert tone="warning">{t("Electronic invoices are issued in EUR: change the currency in the billing settings.")}</Alert>}
        <Alert tone="info">{t("The panel creates the file; sending it to the SDI is done through your accountant's or provider's portal. Download it from the page of each invoice.")}</Alert>
        <Card>
          <CardHeader title={t("Seller")} description={t("As registered with the Agenzia delle Entrate.")} />
          <div className="p-5">
            <ActionForm action={saveEinvoice}>
              <Checkbox name="enabled" defaultChecked={s.enabled} label={t("Enable the XML export")} />
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label={t("Company name")} className="sm:col-span-2"><Input name="name" defaultValue={s.name} maxLength={80} /></Field>
                <Field label={t("VAT number")} hint={t("11 digits, without IT")}><Input name="vatNumber" defaultValue={s.vatNumber} inputMode="numeric" /></Field>
                <Field label={t("Tax code")}><Input name="fiscalCode" defaultValue={s.fiscalCode} /></Field>
                <Field label={t("Tax regime")}><Select name="regime" defaultValue={s.regime}>{REGIMES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select></Field>
                <Field label="IBAN" hint={t("Printed on invoices paid by bank transfer.")}><Input name="iban" defaultValue={s.iban} /></Field>
                <Field label={t("Address")} className="sm:col-span-2"><Input name="address" defaultValue={s.address} maxLength={60} /></Field>
                <Field label={t("ZIP / Postal code")}><Input name="zip" defaultValue={s.zip} inputMode="numeric" maxLength={5} /></Field>
                <Field label={t("City")}><Input name="city" defaultValue={s.city} /></Field>
                <Field label={t("State / Province")} hint="RM, MI…"><Input name="province" defaultValue={s.province} maxLength={2} /></Field>
              </div>
              <div className="grid gap-4 sm:grid-cols-[10rem_1fr]">
                <Field label={t("0% VAT nature")}><Select name="zeroVatNature" defaultValue={s.zeroVatNature}>{NATURES.map((n) => <option key={n}>{n}</option>)}</Select></Field>
                <Field label={t("Legal reference for 0% VAT")} hint={t("Used only when the tax rate is 0, for example for flat-rate sellers.")}><Input name="zeroVatNote" defaultValue={s.zeroVatNote} maxLength={100} placeholder="Operazione in franchigia da IVA ex art. 1 c. 54-89 L. 190/2014" /></Field>
              </div>
              <SubmitButton>{t("Save")}</SubmitButton>
            </ActionForm>
          </div>
        </Card>
        <Card>
          <CardHeader title={t("Sending to the SDI")} description={t("Choose the intermediary you have a contract with. Without one, invoices are only downloadable as XML.")} />
          <div className="p-5">
            <ActionForm action={saveSdi}>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label={t("Intermediary")}>
                  <Select name="provider" defaultValue={sdi.provider}>
                    <option value="">{t("None: download only")}</option>
                    {sdiProviders.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </Select>
                </Field>
                <Field label={t("When")}>
                  <Select name="autoSend" defaultValue={sdi.autoSend}>
                    <option value="manual">{t("Staff sends each invoice from its page")}</option>
                    <option value="paid">{t("Automatically, as soon as an invoice is paid")}</option>
                  </Select>
                </Field>
              </div>
              {sdiProviders.map((p) => (
                <fieldset key={p.id} className="rounded-theme border border-border p-4">
                  <legend className="px-2 text-sm font-medium">{p.name} {sdi.provider === p.id && <span className="ml-1 text-xs font-normal text-success">● {t("in use")}</span>}</legend>
                  <div className="grid gap-4 sm:grid-cols-2">
                    {p.fields.map((f) => (
                      <Field key={f.name} label={t(f.label)} hint={f.help && t(f.help)}>
                        <Input name={`${p.id}.${f.name}`} type={f.type} autoComplete="off" defaultValue={f.type === "password" ? "" : sdi.accounts[p.id]?.[f.name]} placeholder={f.type === "password" && sdi.accounts[p.id]?.[f.name] ? "••••••••  (unchanged)" : ""} />
                      </Field>
                    ))}
                  </div>
                </fieldset>
              ))}
              <Checkbox name="sandbox" defaultChecked={sdi.accounts[sdi.provider]?.sandbox === "1"} label={t("Use the intermediary's test environment (nothing reaches the real SDI)")} />
              <p className="text-xs text-muted">{t("Only the fields of the intermediary selected above are saved.")}</p>
              <SubmitButton>{t("Save")}</SubmitButton>
            </ActionForm>
          </div>
        </Card>
      </div>
    </>
  );
}
