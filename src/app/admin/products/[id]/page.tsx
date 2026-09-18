import { notFound } from "next/navigation";
import { asc, eq } from "drizzle-orm";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { Card, CardHeader, Checkbox, Field, Input, PageHeader, Select, Textarea } from "@/components/ui";
import { getDb, schema } from "@/db";
import { BILLING_CYCLES } from "@/db/schema";
import { getT } from "@/i18n";
import { centsToInput, CYCLE_LABEL } from "@/lib/format";
import { getSettings } from "@/lib/settings";
import { provisioningModules } from "@/modules/provisioning";
import { deleteProduct, saveProduct } from "../../actions";

/** `/admin/products/new` creates, any other id edits. */
export default async function ProductEditor({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const isNew = id === "new";
  if (!isNew && !/^[0-9a-f-]{36}$/i.test(id)) notFound();

  const db = await getDb();
  const [product, groups, servers, t, billing] = await Promise.all([
    isNew ? undefined : db.query.products.findFirst({ where: eq(schema.products.id, id) }),
    db.select().from(schema.productGroups).orderBy(asc(schema.productGroups.position)),
    db.select({ id: schema.servers.id, name: schema.servers.name }).from(schema.servers).orderBy(asc(schema.servers.name)),
    getT(),
    getSettings("billing"),
  ]);
  if (!isNew && !product) notFound();

  return (
    <>
      <PageHeader title={product?.name ?? t("New product")} />
      <ActionForm action={saveProduct} className="space-y-6">
        <input type="hidden" name="id" value={product?.id ?? ""} />
        <Card>
          <CardHeader title={t("Details")} />
          <div className="grid gap-4 p-5 sm:grid-cols-2">
            <Field label={t("Name")}><Input name="name" defaultValue={product?.name} required /></Field>
            <Field label={t("Group")}>
              <Select name="groupId" defaultValue={product?.groupId} required>
                {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
              </Select>
            </Field>
            <Field label={t("Slug")} hint={t("Leave empty to generate from the name.")}><Input name="slug" defaultValue={product?.slug} /></Field>
            <Field label={t("Tagline")}><Input name="tagline" defaultValue={product?.tagline} /></Field>
            <Field label={t("Description")} className="sm:col-span-2"><Textarea name="description" defaultValue={product?.description} rows={3} /></Field>
            <Field label={t("Features")} hint={t("One per line.")} className="sm:col-span-2">
              <Textarea name="features" defaultValue={product?.features.join("\n")} rows={6} />
            </Field>
            <Field label={t("Sort order")}><Input name="position" type="number" defaultValue={product?.position ?? 0} /></Field>
            <div className="flex flex-wrap items-end gap-x-6 gap-y-2 pb-2">
              <Checkbox name="requiresDomain" defaultChecked={product?.requiresDomain ?? true} label={t("Requires a domain")} />
              <Checkbox name="featured" defaultChecked={product?.featured} label={t("Featured")} />
              <Checkbox name="hidden" defaultChecked={product?.hidden} label={t("Hidden")} />
            </div>
          </div>
        </Card>

        <Card>
          <CardHeader title={t("Pricing")} description={t("In {currency}. Leave a cycle empty to disable it.", { currency: billing.currency })} />
          <div className="grid gap-4 p-5 sm:grid-cols-3 lg:grid-cols-4">
            {BILLING_CYCLES.map((c) => (
              <Field key={c} label={t(CYCLE_LABEL[c])}>
                <Input name={`price_${c}`} inputMode="decimal" placeholder="—" defaultValue={centsToInput(product?.pricing[c])} />
              </Field>
            ))}
            <Field label={t("Setup fee")}>
              <Input name="price_setup" inputMode="decimal" placeholder="—" defaultValue={centsToInput(product?.pricing.setup)} />
            </Field>
          </div>
        </Card>

        <Card>
          <CardHeader title={t("Provisioning")} description={t("What happens when the service is paid.")} />
          <div className="grid gap-4 p-5 sm:grid-cols-2">
            <Field label={t("Module")}>
              <Select name="module" defaultValue={product?.module ?? "manual"}>
                {provisioningModules.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
              </Select>
            </Field>
            <Field label={t("Server")}>
              <Select name="serverId" defaultValue={product?.serverId ?? ""}>
                <option value="">—</option>
                {servers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </Select>
            </Field>
            {provisioningModules.flatMap((m) =>
              m.productFields.map((f) => (
                <Field key={`${m.id}.${f.name}`} label={`${m.name}: ${f.label}`} hint={f.help}>
                  <Input
                    name={`mc_${m.id}_${f.name}`}
                    placeholder={f.placeholder}
                    defaultValue={product?.module === m.id ? product.moduleConfig[f.name] : ""}
                  />
                </Field>
              )),
            )}
          </div>
        </Card>
        <SubmitButton>{t("Save")}</SubmitButton>
      </ActionForm>

      {product && (
        <ActionForm action={deleteProduct} className="mt-10 border-t border-border pt-6">
          <input type="hidden" name="id" value={product.id} />
          <SubmitButton variant="danger" confirm={t("Delete this product?")}>{t("Delete product")}</SubmitButton>
        </ActionForm>
      )}
    </>
  );
}
