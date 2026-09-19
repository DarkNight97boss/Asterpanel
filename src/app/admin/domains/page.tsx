import Link from "next/link";
import { asc, desc, eq } from "drizzle-orm";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { ButtonLink, Card, CardHeader, Checkbox, EmptyState, Field, Input, PageHeader, Select, StatusBadge, Table, Td } from "@/components/ui";
import { getDb, schema } from "@/db";
import { getLocale, getT } from "@/i18n";
import { requireArea } from "@/lib/auth";
import { centsToInput, displayName, formatDate, formatMoney } from "@/lib/format";
import { firstYearPrice } from "@/lib/domains";
import { getSettings } from "@/lib/settings";
import { registrarModules } from "@/modules/registrars";
import { deleteTld, saveTld, syncDomainNow } from "./actions";

export const metadata = { title: "Domains" };

export default async function AdminDomains() {
  const me = await requireArea("billing");
  const db = await getDb();
  const [t, locale, billing, tlds, names] = await Promise.all([
    getT(),
    getLocale(),
    getSettings("billing"),
    db.select().from(schema.domainTlds).orderBy(asc(schema.domainTlds.sort), asc(schema.domainTlds.tld)),
    db.select({ d: schema.domainNames, u: { id: schema.users.id, firstName: schema.users.firstName, lastName: schema.users.lastName, email: schema.users.email } }).from(schema.domainNames).innerJoin(schema.users, eq(schema.users.id, schema.domainNames.clientId)).orderBy(desc(schema.domainNames.createdAt)).limit(200),
  ]);
  const admin = me.role === "admin";
  const money = (c: number) => formatMoney(c, billing.currency, locale);
  const regName = (id: string) => registrarModules.find((m) => m.id === id)?.name ?? id;

  return (
    <>
      <PageHeader title={t("Domains")} description={t("Extensions on sale and every domain name managed through the registrars.")} action={admin && <ButtonLink href="/admin/settings/registrars" variant="secondary">{t("Domain registrars")}</ButtonLink>} />
      <div className="space-y-6">
        <Card>
          <CardHeader title={t("Extensions and prices")} description={t("Prices are per year, before tax. Renewals keep the price the client ordered at.")} />
          {tlds.length > 0 && (
            <Table head={[t("Extension"), t("Registrar"), t("Register"), t("Renew"), t("Transfer"), t("Status"), ""]}>
              {tlds.map((x) => (
                <tr key={x.id}>
                  <Td className="font-medium">.{x.tld}</Td>
                  <Td className="text-body">{regName(x.registrar)}</Td>
                  <Td>{money(x.registerPrice)}{firstYearPrice(x) < x.registerPrice && <span className="ml-2 text-xs text-success">{t("promo")} {money(x.promoPrice!)}{x.promoUntil && ` → ${formatDate(x.promoUntil, locale)}`}</span>}</Td>
                  <Td>{money(x.renewPrice)}</Td>
                  <Td>{money(x.transferPrice)}</Td>
                  <Td><StatusBadge status={x.enabled ? "active" : "stopped"} label={x.enabled ? t("On sale") : t("Hidden")} /></Td>
                  <Td className="text-right">
                    {admin && (
                      <ActionForm action={deleteTld}>
                        <input type="hidden" name="id" value={x.id} />
                        <SubmitButton size="sm" variant="ghost">{t("Remove")}</SubmitButton>
                      </ActionForm>
                    )}
                  </Td>
                </tr>
              ))}
            </Table>
          )}
          {admin && (
            <div className="border-t border-border p-5">
              <ActionForm action={saveTld}>
                <p className="text-sm text-muted">{t("Add an extension, or type an existing one to change it.")}</p>
                <div className="grid gap-4 sm:grid-cols-3 xl:grid-cols-4">
                  <Field label={t("Extension")}><Input name="tld" required placeholder="com" /></Field>
                  <Field label={t("Registrar")}><Select name="registrar">{registrarModules.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</Select></Field>
                  <Field label={t("Register")}><Input name="registerPrice" required inputMode="decimal" placeholder={centsToInput(1290)} /></Field>
                  <Field label={t("Renew")}><Input name="renewPrice" required inputMode="decimal" placeholder={centsToInput(1490)} /></Field>
                  <Field label={t("Transfer")}><Input name="transferPrice" required inputMode="decimal" placeholder={centsToInput(1190)} /></Field>
                  <Field label={t("Promo first year")} hint={t("Empty = none")}><Input name="promoPrice" inputMode="decimal" /></Field>
                  <Field label={t("Promo until")}><Input name="promoUntil" type="date" /></Field>
                  <Field label={t("Position")}><Input name="sort" type="number" min={0} defaultValue={tlds.length + 1} /></Field>
                </div>
                <Checkbox name="enabled" defaultChecked label={t("On sale")} />
                <SubmitButton>{t("Save extension")}</SubmitButton>
              </ActionForm>
            </div>
          )}
        </Card>

        <Card>
          <CardHeader title={t("Domain names")} />
          {names.length ? (
            <Table head={[t("Domain"), t("Client"), t("Registrar"), t("Expires"), t("Status"), ""]}>
              {names.map(({ d, u }) => (
                <tr key={d.id}>
                  <Td className="font-medium">{d.name}{d.statusMessage && <span className="block max-w-sm text-xs font-normal break-words text-danger">{d.statusMessage}</span>}</Td>
                  <Td><Link href={`/admin/clients/${u.id}`} className="text-link">{displayName(u)}</Link></Td>
                  <Td className="text-body">{regName(d.registrar)}</Td>
                  <Td className="text-body">{d.expiresAt ? formatDate(d.expiresAt, locale) : "—"}</Td>
                  <Td><StatusBadge status={d.status === "transferring" ? "creating" : d.status === "failed" ? "error" : d.status} label={t(d.status)} /></Td>
                  <Td className="text-right">
                    <div className="flex justify-end gap-1">
                      {d.status === "failed" && d.serviceId && <ButtonLink href={`/admin/services/${d.serviceId}`} size="sm" variant="ghost">{t("Retry")}</ButtonLink>}
                      <ActionForm action={syncDomainNow}><input type="hidden" name="id" value={d.id} /><SubmitButton size="sm" variant="ghost">{t("Sync")}</SubmitButton></ActionForm>
                    </div>
                  </Td>
                </tr>
              ))}
            </Table>
          ) : (
            <EmptyState title={t("Nothing here yet")} />
          )}
        </Card>
      </div>
    </>
  );
}
