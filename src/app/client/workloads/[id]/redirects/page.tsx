import { ActionForm, SubmitButton } from "@/components/action-form";
import { Button, Card, EmptyState, Field, Input, PageHeader, Select, Table, Td } from "@/components/ui";
import { getT } from "@/i18n";
import { requireWorkload } from "@/platform/access";
import { addRedirect, removeRedirect } from "../../../platform-actions";

export default async function Redirects({ params }: { params: Promise<{ id: string }> }) {
  const { workload: w } = await requireWorkload((await params).id);
  const t = await getT();
  const rules = w.config.redirects ?? [];
  return (
    <>
      <PageHeader title={t("Redirects")} description={t("Rules run at the edge, before the request reaches your site: fast, and they work even if the site is down.")} />
      <div className="space-y-6">
        <Card className="p-6">
          <h2 className="mb-5 text-xl font-medium">{t("Add redirect rule")}</h2>
          <ActionForm action={addRedirect}>
            <input type="hidden" name="id" value={w.id} />
            <div className="grid gap-4 md:grid-cols-[1fr_1fr_12rem]">
              <Field label={t("Redirect from")} hint={t("A path on this site, e.g. /old-page")}><Input name="from" placeholder="/old-page" required pattern="/.*" /></Field>
              <Field label={t("Redirect to")} hint={t("A path or a full URL")}><Input name="to" placeholder="/new-page" required /></Field>
              <Field label={t("Status code")}>
                <Select name="code" defaultValue="301">
                  <option value="301">301 — {t("Permanent")}</option>
                  <option value="302">302 — {t("Temporary")}</option>
                </Select>
              </Field>
            </div>
            <SubmitButton>{t("Add redirect rule")}</SubmitButton>
          </ActionForm>
        </Card>
        <Card>
          {rules.length ? (
            <Table head={[t("Redirect from"), t("Redirect to"), t("Status code"), ""]}>
              {rules.map((r) => (
                <tr key={r.from}>
                  <Td className="font-mono text-xs">{r.from}</Td>
                  <Td className="font-mono text-xs break-all">{r.to}</Td>
                  <Td>{r.code}</Td>
                  <Td className="text-right">
                    <form action={removeRedirect}>
                      <input type="hidden" name="id" value={w.id} />
                      <input type="hidden" name="from" value={r.from} />
                      <Button size="sm" variant="ghost">{t("Remove")}</Button>
                    </form>
                  </Td>
                </tr>
              ))}
            </Table>
          ) : (
            <EmptyState title={t("No redirect rules yet")} />
          )}
        </Card>
      </div>
    </>
  );
}
