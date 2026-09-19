import { ActionForm, SubmitButton } from "@/components/action-form";
import { Badge, ButtonLink, Card, CardHeader, Checkbox, Field, Input, PageHeader, Textarea } from "@/components/ui";
import { getT } from "@/i18n";
import { requireAdmin } from "@/lib/auth";
import { getSettings } from "@/lib/settings";
import { registrarModules } from "@/modules/registrars";
import { saveRegistrar, saveRegistrarNameservers, testRegistrarConnection } from "../../domains/actions";

export const metadata = { title: "Domain registrars" };

export default async function Registrars() {
  await requireAdmin();
  const [t, s] = await Promise.all([getT(), getSettings("registrars")]);
  return (
    <>
      <PageHeader title={t("Domain registrars")} description={t("The reseller accounts used to register, transfer and renew domain names.")} action={<ButtonLink href="/admin/domains" variant="secondary">{t("Extensions and prices")}</ButtonLink>} />
      <div className="grid items-start gap-6 xl:grid-cols-2">
        {registrarModules.map((mod) => {
          const account = s.accounts[mod.id] ?? {};
          const configured = mod.fields.every((f) => account[f.name]);
          return (
            <Card key={mod.id}>
              <CardHeader title={<span className="flex items-center gap-3">{mod.name} {configured ? <Badge tone="success">{t("Configured")}</Badge> : <Badge>{t("Not configured")}</Badge>}</span>} description={mod.website.replace("https://", "")} />
              <div className="space-y-4 p-5">
                <ActionForm action={saveRegistrar}>
                  <input type="hidden" name="registrar" value={mod.id} />
                  {mod.fields.map((f) => (
                    <Field key={f.name} label={t(f.label)} hint={f.help && t(f.help)}>
                      <Input name={f.name} type={f.type} autoComplete="off" defaultValue={f.type === "password" ? "" : account[f.name]} placeholder={f.type === "password" && account[f.name] ? "••••••••  (unchanged)" : ""} />
                    </Field>
                  ))}
                  <Checkbox name="sandbox" defaultChecked={account.sandbox === "1"} label={t("Use the test environment (no real registrations)")} />
                  <SubmitButton>{t("Save")}</SubmitButton>
                </ActionForm>
                {configured && (
                  <ActionForm action={testRegistrarConnection}>
                    <input type="hidden" name="registrar" value={mod.id} />
                    <SubmitButton variant="secondary">{t("Test the connection")}</SubmitButton>
                  </ActionForm>
                )}
              </div>
            </Card>
          );
        })}

        <Card>
          <CardHeader title={t("Default name servers")} description={t("Given to every new registration. Use your own DNS cluster or the one of your DNS provider.")} />
          <div className="p-5">
            <ActionForm action={saveRegistrarNameservers}>
              <Field label={t("Name servers")} hint={t("One per line, between 2 and 6.")}><Textarea name="nameservers" rows={4} defaultValue={s.nameservers.join("\n")} placeholder={"ns1.example.com\nns2.example.com"} /></Field>
              <SubmitButton>{t("Save")}</SubmitButton>
            </ActionForm>
          </div>
        </Card>
      </div>
    </>
  );
}
