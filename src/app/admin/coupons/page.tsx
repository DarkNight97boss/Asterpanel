import { desc } from "drizzle-orm";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { Button, Card, CardHeader, EmptyState, Field, Input, PageHeader, Select, StatusBadge, Table, Td } from "@/components/ui";
import { getDb, schema } from "@/db";
import { getLocale, getT } from "@/i18n";
import { requireArea } from "@/lib/auth";
import { formatDate, formatMoney } from "@/lib/format";
import { getSettings } from "@/lib/settings";
import { saveCoupon, toggleCoupon } from "../extras-actions";

export const metadata = { title: "Discount codes" };

export default async function Coupons() {
  await requireArea("billing");
  const [t, locale, billing, rows] = await Promise.all([getT(), getLocale(), getSettings("billing"), (await getDb()).select().from(schema.coupons).orderBy(desc(schema.coupons.createdAt))]);
  return (
    <>
      <PageHeader title={t("Discount codes")} description={t("A code lowers the first invoice of a new order. Renewals stay at list price.")} />
      <div className="space-y-6">
        <Card>
          {rows.length ? (
            <Table head={[t("Code"), t("Discount"), t("Used"), t("Expires"), t("Status"), ""]}>
              {rows.map((c) => (
                <tr key={c.id}>
                  <Td><code className="font-mono font-medium">{c.code}</code></Td>
                  <Td>{c.kind === "percent" ? `${c.value}%` : formatMoney(c.value, billing.currency, locale)}</Td>
                  <Td className="text-body">{c.used}{c.maxUses ? ` / ${c.maxUses}` : ""}</Td>
                  <Td className="text-body">{c.expiresAt ? formatDate(c.expiresAt, locale) : t("Never")}</Td>
                  <Td><StatusBadge status={c.enabled ? "active" : "stopped"} label={c.enabled ? t("Active") : t("Disabled")} /></Td>
                  <Td className="text-right"><form action={toggleCoupon}><input type="hidden" name="id" value={c.id} /><Button size="sm" variant="ghost">{c.enabled ? t("Disable") : t("Enable")}</Button></form></Td>
                </tr>
              ))}
            </Table>
          ) : (
            <EmptyState title={t("Nothing here yet")} />
          )}
        </Card>
        <Card>
          <CardHeader title={t("New code")} description={t("Saving an existing code replaces its settings.")} />
          <div className="p-5">
            <ActionForm action={saveCoupon}>
              <div className="grid gap-4 sm:grid-cols-5">
                <Field label={t("Code")}><Input name="code" required maxLength={40} placeholder="WELCOME20" className="uppercase" /></Field>
                <Field label={t("Type")}><Select name="kind" defaultValue="percent"><option value="percent">%</option><option value="fixed">{billing.currency}</option></Select></Field>
                <Field label={t("Value")}><Input name="value" required inputMode="decimal" placeholder="20" /></Field>
                <Field label={t("Maximum uses")} hint={t("0 = unlimited")}><Input name="maxUses" type="number" min={0} defaultValue={0} /></Field>
                <Field label={t("Expires")}><Input name="expiresAt" type="date" /></Field>
              </div>
              <SubmitButton>{t("Save")}</SubmitButton>
            </ActionForm>
          </div>
        </Card>
      </div>
    </>
  );
}
