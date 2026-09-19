import Link from "next/link";
import { notFound } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { ShellSlot } from "@/components/portal";
import { Alert, Card, CardHeader, DataField, Field, StatusBadge, Textarea, Input } from "@/components/ui";
import { getDb, schema } from "@/db";
import { getLocale, getT } from "@/i18n";
import { requireAccount } from "@/lib/account";
import { formatDate, formatDateTime } from "@/lib/format";
import { refresh, revealAuthCode, saveContact, saveNameservers, toggleLock } from "../actions";

export default async function DomainDetail({ params }: { params: Promise<{ id: string }> }) {
  const { account, can } = await requireAccount("hosting");
  const id = (await params).id;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const [d] = await (await getDb()).select().from(schema.domainNames).where(and(eq(schema.domainNames.id, id), eq(schema.domainNames.companyId, account.id)));
  if (!d) notFound();
  const [t, locale] = await Promise.all([getT(), getLocale()]);
  const active = d.status === "active";

  return (
    <>
      <ShellSlot slot="crumbs">
        <span className="text-white/40">/</span>
        <Link href="/client/domains" className="hidden text-white/85 hover:text-white sm:inline">{t("Domains")}</Link>
        <span className="hidden text-white/40 sm:inline">/</span>
        <span className="truncate font-medium">{d.name}</span>
      </ShellSlot>
      <h1 className="mb-6 text-2xl tracking-tight">{d.name}</h1>
      <div className="space-y-6">
        {d.status === "pending" && <Alert tone="info">{t("This domain is registered as soon as its invoice is paid.")} {d.serviceId && <Link href="/client/invoices" className="underline">{t("Invoices")}</Link>}</Alert>}
        {d.status === "transferring" && <Alert tone="info">{t("The transfer is in progress. It usually completes in 5 to 7 days; check the inbox of the registrant email for a confirmation request.")}</Alert>}
        {d.status === "failed" && <Alert tone="danger">{t("The registration did not go through. Our team will complete it or contact you.")}</Alert>}

        <Card>
          <CardHeader title={t("Details")} action={active && <ActionForm action={refresh}><input type="hidden" name="id" value={d.id} /><SubmitButton size="sm" variant="secondary">{t("Refresh")}</SubmitButton></ActionForm>} />
          <div className="grid gap-5 p-5 sm:grid-cols-2 lg:grid-cols-4">
            <DataField label={t("Status")}><StatusBadge status={d.status === "transferring" ? "creating" : d.status === "failed" ? "error" : d.status} label={t(d.status)} /></DataField>
            <DataField label={t("Expires")}>{d.expiresAt ? formatDate(d.expiresAt, locale) : "—"}</DataField>
            <DataField label={t("Renewal")}>{t("Automatic, by invoice before the expiry")}</DataField>
            <DataField label={t("Last checked")}>{d.syncedAt ? formatDateTime(d.syncedAt, locale) : "—"}</DataField>
          </div>
        </Card>

        {active && can("manage") && (
          <Card>
            <CardHeader title={t("Registrant")} description={t("The legal owner as known to the registry. Keep it current: an unreachable owner can lose the domain.")} />
            <div className="p-5">
              <ActionForm action={saveContact}>
                <input type="hidden" name="id" value={d.id} />
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  {([["firstName", "First name"], ["lastName", "Last name"], ["organization", "Organization"], ["email", "Email"], ["phone", "Phone"], ["taxCode", "Tax code"], ["address", "Address"], ["city", "City"], ["zip", "ZIP / Postal code"], ["state", "State / Province"], ["country", "Country"]] as const).map(([name, label]) => (
                    <Field key={name} label={t(label)}><Input name={name} defaultValue={d.contact[name] ?? ""} required={!["organization", "state", "taxCode"].includes(name)} maxLength={name === "country" ? 2 : 200} /></Field>
                  ))}
                </div>
                <SubmitButton variant="secondary">{t("Save")}</SubmitButton>
              </ActionForm>
            </div>
          </Card>
        )}

        {active && (
          <div className="grid items-start gap-6 xl:grid-cols-2">
            <Card>
              <CardHeader title={t("Name servers")} description={t("Where the DNS of this domain is hosted.")} />
              <div className="p-5">
                <ActionForm action={saveNameservers}>
                  <input type="hidden" name="id" value={d.id} />
                  <Field label={t("Name servers")} hint={t("One per line, between 2 and 6.")}><Textarea name="nameservers" rows={4} defaultValue={d.nameservers.join("\n")} className="font-mono" /></Field>
                  <SubmitButton>{t("Save")}</SubmitButton>
                </ActionForm>
              </div>
            </Card>

            {can("manage") && (
              <Card>
                <CardHeader title={t("Transfer away")} description={t("The lock stops anyone from moving the domain to another registrar. Unlock it and get the transfer code only when you really want to move it.")} />
                <div className="space-y-4 p-5">
                  <DataField label={t("Transfer lock")}>{d.locked ? `🔒 ${t("Locked")}` : t("Unlocked")}</DataField>
                  <ActionForm action={toggleLock}>
                    <input type="hidden" name="id" value={d.id} />
                    <input type="hidden" name="locked" value={d.locked ? "0" : "1"} />
                    <SubmitButton variant="secondary">{d.locked ? t("Unlock") : t("Lock")}</SubmitButton>
                  </ActionForm>
                  {!d.locked && (
                    <ActionForm action={revealAuthCode}>
                      <input type="hidden" name="id" value={d.id} />
                      <SubmitButton variant="secondary">{t("Show transfer code")}</SubmitButton>
                    </ActionForm>
                  )}
                </div>
              </Card>
            )}
          </div>
        )}
      </div>
    </>
  );
}
