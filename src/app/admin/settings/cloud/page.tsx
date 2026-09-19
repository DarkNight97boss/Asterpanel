import { ActionForm, SubmitButton } from "@/components/action-form";
import { Alert, Badge, ButtonLink, Card, CardHeader, Checkbox, Field, Input, PageHeader, Textarea } from "@/components/ui";
import { getT } from "@/i18n";
import { requireAdmin } from "@/lib/auth";
import { getSettings } from "@/lib/settings";
import { cloudProviders } from "@/modules/cloud";
import { saveCloudProvider, testCloud } from "../../platform-actions";

export const metadata = { title: "Cloud providers" };

export default async function CloudSettings() {
  await requireAdmin();
  const [t, s, general] = await Promise.all([getT(), getSettings("cloud"), getSettings("general")]);
  return (
    <>
      <PageHeader title={t("Cloud providers")} description={t("Switch on the providers you want to create servers on. Your own physical servers need nothing here: add them from the Nodes page.")} action={<ButtonLink href="/admin/nodes" variant="secondary">{t("Nodes")}</ButtonLink>} />
      {!general.siteUrl && !process.env.APP_URL && <div className="mb-6 max-w-3xl"><Alert tone="warning">{t("Set the Site URL in Settings: new servers download the agent from it.")}</Alert></div>}
      <div className="grid items-start gap-6 xl:grid-cols-2">
        {cloudProviders.map((p) => {
          const account = s.accounts[p.id] ?? {};
          return (
            <Card key={p.id}>
              <CardHeader title={<span className="flex items-center gap-3">{p.name} {account.enabled === "1" ? <Badge tone="success">{t("Enabled")}</Badge> : <Badge>{t("Off")}</Badge>}</span>} description={p.website.replace("https://", "")} />
              <div className="space-y-4 p-5">
                <ActionForm action={saveCloudProvider}>
                  <input type="hidden" name="provider" value={p.id} />
                  <Checkbox name="enabled" defaultChecked={account.enabled === "1"} label={t("Offer this provider when creating servers")} />
                  {p.fields.map((f) => (
                    <Field key={f.name} label={`${t(f.label)}${f.optional ? ` (${t("optional")})` : ""}`} hint={f.help && t(f.help)}>
                      {f.type === "textarea" ? (
                        <Textarea name={f.name} rows={4} autoComplete="off" className="font-mono text-xs" placeholder={account[f.name] ? "••••••••  (unchanged)" : '{ "type": "service_account", … }'} />
                      ) : (
                        <Input name={f.name} type={f.type} autoComplete="off" defaultValue={f.type === "text" ? account[f.name] : ""} placeholder={f.type === "password" && account[f.name] ? "••••••••  (unchanged)" : ""} />
                      )}
                    </Field>
                  ))}
                  <Field label={t("Let's Encrypt contact email")} hint={t("Shared by all providers; given to the servers created from here.")}><Input name="acmeEmail" type="email" defaultValue={s.acmeEmail} /></Field>
                  <SubmitButton>{t("Save")}</SubmitButton>
                </ActionForm>
                {account.enabled === "1" && (
                  <ActionForm action={testCloud}>
                    <input type="hidden" name="provider" value={p.id} />
                    <SubmitButton variant="secondary">{t("Test the connection")}</SubmitButton>
                  </ActionForm>
                )}
              </div>
            </Card>
          );
        })}
      </div>
    </>
  );
}
