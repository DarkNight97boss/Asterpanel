import { desc, eq } from "drizzle-orm";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { Badge, Button, Card, CardHeader, EmptyState, Field, Input, PageHeader, Select, Table, Td } from "@/components/ui";
import { getDb, schema } from "@/db";
import { getLocale, getT } from "@/i18n";
import { requireAccount } from "@/lib/account";
import { listApiKeys } from "@/lib/api-keys";
import { formatDate, formatDateTime } from "@/lib/format";
import { baseUrl } from "@/lib/url";
import { WEBHOOK_EVENTS } from "@/lib/webhooks";
import { newApiKey, newWebhook, pingWebhook, removeApiKey, removeWebhook } from "./actions";

export const metadata = { title: "API & webhooks" };

export default async function CompanyApi() {
  const { account } = await requireAccount("manage");
  const [t, locale, origin, keys, hooks] = await Promise.all([getT(), getLocale(), baseUrl(), listApiKeys(account.id), (await getDb()).select().from(schema.webhooks).where(eq(schema.webhooks.companyId, account.id)).orderBy(desc(schema.webhooks.createdAt))]);

  return (
    <>
      <PageHeader title={t("API & webhooks")} description={t("Automate {account}: call the REST API with a key, and get notified when something happens.", { account: account.name })} />
      <div className="space-y-6">
        <Card>
          <CardHeader title={t("API keys")} description={t("Send the key as “Authorization: Bearer <key>”. A key acts on the whole company: keep it secret and prefer read-only keys.")} />
          {keys.length > 0 && (
            <Table head={[t("Name"), t("Key"), t("Access"), t("Last used"), t("Expires"), ""]}>
              {keys.map((k) => (
                <tr key={k.id}>
                  <Td className="font-medium">{k.name}</Td>
                  <Td><code className="font-mono text-xs">{k.prefix}…</code></Td>
                  <Td>{k.scope === "write" ? <Badge tone="warning">{t("Read and write")}</Badge> : <Badge>{t("Read only")}</Badge>}</Td>
                  <Td className="text-body">{k.lastUsedAt ? formatDateTime(k.lastUsedAt, locale) : t("Never")}</Td>
                  <Td className="text-body">{k.expiresAt ? formatDate(k.expiresAt, locale) : t("Never")}</Td>
                  <Td className="text-right"><form action={removeApiKey}><input type="hidden" name="id" value={k.id} /><Button size="sm" variant="ghost">{t("Revoke")}</Button></form></Td>
                </tr>
              ))}
            </Table>
          )}
          <div className="border-t border-border p-5">
            <ActionForm action={newApiKey}>
              <div className="grid gap-4 sm:grid-cols-3">
                <Field label={t("Name")}><Input name="name" required maxLength={60} placeholder="CI pipeline" /></Field>
                <Field label={t("Access")}><Select name="scope" defaultValue="read"><option value="read">{t("Read only")}</option><option value="write">{t("Read and write")}</option></Select></Field>
                <Field label={t("Expires")}><Select name="expires" defaultValue="0"><option value="0">{t("Never")}</option><option value="30">30 {t("days")}</option><option value="90">90 {t("days")}</option><option value="365">365 {t("days")}</option></Select></Field>
              </div>
              <SubmitButton>{t("Create key")}</SubmitButton>
            </ActionForm>
          </div>
        </Card>

        <Card>
          <CardHeader title={t("Endpoints")} description={t("All under {base}. Writes are asynchronous and answer 202 with what was queued. 120 requests per minute per key.", { base: `${origin}/api/v1` })} />
          <pre className="overflow-x-auto px-5 pb-5 font-mono text-xs leading-relaxed text-body">{`GET  /sites                      GET  /sites/:id
GET  /sites/:id/backups          POST /sites/:id/backups      {"note": "…"}
GET  /sites/:id/deployments      POST /sites/:id/deploy
POST /sites/:id/restart          POST /sites/:id/purge-cache
GET  /domains                    GET  /invoices

curl -H "Authorization: Bearer $ASTER_KEY" ${origin}/api/v1/sites`}</pre>
        </Card>

        <Card>
          <CardHeader title={t("Webhooks")} description={t("We POST a JSON event to your address. Verify the X-Aster-Signature header: t=<timestamp>,v1=HMAC-SHA256(secret, \"<t>.<body>\").")} />
          {hooks.length ? (
            <Table head={[t("Address"), t("Events"), t("Last delivery"), ""]}>
              {hooks.map((h) => (
                <tr key={h.id}>
                  <Td className="max-w-xs truncate font-medium">{h.url}{!h.enabled && <span className="ml-2"><Badge tone="danger">{t("Disabled after repeated failures")}</Badge></span>}</Td>
                  <Td className="text-xs text-body">{h.events.join(", ")}</Td>
                  <Td className="text-body">{h.lastAt ? `${h.lastStatus} · ${formatDateTime(h.lastAt, locale)}` : "—"}</Td>
                  <Td className="text-right">
                    <div className="flex justify-end gap-1">
                      <ActionForm action={pingWebhook} className=""><input type="hidden" name="id" value={h.id} /><SubmitButton size="sm" variant="ghost">{t("Send test")}</SubmitButton></ActionForm>
                      <form action={removeWebhook}><input type="hidden" name="id" value={h.id} /><Button size="sm" variant="ghost">{t("Remove")}</Button></form>
                    </div>
                  </Td>
                </tr>
              ))}
            </Table>
          ) : (
            <EmptyState title={t("No webhooks yet")} />
          )}
          <div className="border-t border-border p-5">
            <ActionForm action={newWebhook}>
              <Field label={t("Address")}><Input name="url" type="url" required placeholder="https://example.com/hooks/aster" /></Field>
              <fieldset className="grid gap-2 text-sm sm:grid-cols-3">
                {WEBHOOK_EVENTS.map((e) => <label key={e} className="flex items-center gap-2"><input type="checkbox" name="events" value={e} defaultChecked className="accent-(--accent)" /><code className="font-mono text-xs">{e}</code></label>)}
              </fieldset>
              <SubmitButton>{t("Add webhook")}</SubmitButton>
            </ActionForm>
          </div>
        </Card>
      </div>
    </>
  );
}
