import Link from "next/link";
import { asc } from "drizzle-orm";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { Badge, Button, ButtonLink, Card, CardHeader, EmptyState, Field, Input, PageHeader, Table, Td } from "@/components/ui";
import { getDb, schema } from "@/db";
import { getLocale, getT } from "@/i18n";
import { CYCLE_SUFFIX, formatMoney, headlineCycle } from "@/lib/format";
import { getSettings } from "@/lib/settings";
import { getProvisioningModule } from "@/modules/provisioning";
import { deleteGroup, saveGroup } from "../actions";

export default async function Products() {
  const db = await getDb();
  const [t, locale, billing, groups] = await Promise.all([
    getT(),
    getLocale(),
    getSettings("billing"),
    db.query.productGroups.findMany({
      with: { products: { orderBy: [asc(schema.products.position), asc(schema.products.name)] } },
      orderBy: [asc(schema.productGroups.position), asc(schema.productGroups.name)],
    }),
  ]);

  return (
    <>
      <PageHeader
        title={t("Products")}
        description={t("Groups become pricing tables on your site.")}
        action={groups.length > 0 && <ButtonLink href="/admin/products/new">{t("New product")}</ButtonLink>}
      />
      <div className="space-y-6">
        {groups.map((g) => (
          <Card key={g.id}>
            <CardHeader
              title={g.name}
              description={`/${g.slug}${g.description ? ` · ${g.description}` : ""}`}
              action={
                g.products.length === 0 && (
                  <form action={deleteGroup}>
                    <input type="hidden" name="id" value={g.id} />
                    <Button variant="ghost" size="sm">{t("Delete group")}</Button>
                  </form>
                )
              }
            />
            {g.products.length ? (
              <Table head={[t("Product"), t("Price"), t("Module"), ""]}>
                {g.products.map((p) => {
                  const cycle = headlineCycle(p.pricing);
                  return (
                    <tr key={p.id}>
                      <Td>
                        <Link href={`/admin/products/${p.id}`} className="font-medium hover:text-primary">{p.name}</Link>
                        <span className="block text-xs text-muted">/order/{p.slug}</span>
                      </Td>
                      <Td>{cycle ? `${formatMoney(p.pricing[cycle]!, billing.currency, locale)}${t(CYCLE_SUFFIX[cycle])}` : "—"}</Td>
                      <Td>{getProvisioningModule(p.module).name}</Td>
                      <Td className="space-x-1 text-right">
                        {p.featured && <Badge tone="info">{t("Featured")}</Badge>}
                        {p.hidden && <Badge>{t("Hidden")}</Badge>}
                      </Td>
                    </tr>
                  );
                })}
              </Table>
            ) : (
              <EmptyState title={t("No products in this group")} />
            )}
          </Card>
        ))}

        <Card>
          <CardHeader title={t("New group")} />
          <div className="p-5">
            <ActionForm action={saveGroup} className="grid items-end gap-4 space-y-0 sm:grid-cols-[1fr_1fr_auto]">
              <Field label={t("Name")}><Input name="name" required placeholder="VPS" /></Field>
              <Field label={t("Description")}><Input name="description" /></Field>
              <SubmitButton>{t("Add group")}</SubmitButton>
            </ActionForm>
          </div>
        </Card>
      </div>
    </>
  );
}
