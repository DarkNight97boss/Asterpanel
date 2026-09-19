import { ActionForm, SubmitButton } from "@/components/action-form";
import { Alert, Badge, ButtonLink, Card, CardHeader, Checkbox, Field, Input, PageHeader, Select, Textarea } from "@/components/ui";
import { getT } from "@/i18n";
import { requireAdmin } from "@/lib/auth";
import { getSettings } from "@/lib/settings";
import { cloudProviders } from "@/modules/cloud";
import { rotateMetricsToken, saveCloudProvider, saveInfrastructureMode, testCloud } from "../../platform-actions";

export const metadata = { title: "Infrastructure" };

export default async function CloudSettings() {
  await requireAdmin();
  const [t, s, general, platform] = await Promise.all([getT(), getSettings("cloud"), getSettings("general"), getSettings("platform")]);
  const a = s.autoscale;
  return (
    <>
      <PageHeader title={t("Infrastructure")} description={t("Switch on the providers you want to create servers on. Your own physical servers need nothing here: add them from the Nodes page.")} action={<ButtonLink href="/admin/nodes" variant="secondary">{t("Nodes")}</ButtonLink>} />
      {!general.siteUrl && !process.env.APP_URL && <div className="mb-6 max-w-3xl"><Alert tone="warning">{t("Set the Site URL in Settings: new servers download the agent from it.")}</Alert></div>}
      <Card className="mb-6">
        <CardHeader title={t("How servers are added")} description={t("Decide who provides the machines your customers' containers run on. You can mix both: automatic servers are added next to the ones you manage yourself.")} />
        <div className="p-5">
          <ActionForm action={saveInfrastructureMode}>
            <div className="grid gap-3 lg:grid-cols-2">
              <label className="flex cursor-pointer gap-3 rounded-theme border border-border p-4 has-checked:border-fg has-checked:bg-subtle">
                <input type="radio" name="mode" value="manual" defaultChecked={!a.enabled} className="mt-1 accent-(--accent)" />
                <span><span className="block font-medium">{t("Servers I add myself")}</span><span className="text-sm text-muted">{t("Your own physical servers, or cloud servers you create one by one from the Nodes page. When they are full, new orders wait for you to add room.")}</span></span>
              </label>
              <label className="flex cursor-pointer gap-3 rounded-theme border border-border p-4 has-checked:border-fg has-checked:bg-subtle">
                <input type="radio" name="mode" value="auto" defaultChecked={a.enabled} className="mt-1 accent-(--accent)" />
                <span><span className="block font-medium">{t("Automatic, on a cloud provider")}</span><span className="text-sm text-muted">{t("When no server has room, the panel creates one at the provider below and places the new site on it. Nobody has to be at the keyboard.")}</span></span>
              </label>
            </div>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <Field label={t("Provider")}><Select name="provider" defaultValue={a.provider}>{cloudProviders.map((p) => <option key={p.id} value={p.id}>{p.name}{s.accounts[p.id]?.enabled === "1" ? "" : ` (${t("Off")})`}</option>)}</Select></Field>
              <Field label={t("Region")} hint={t("As the provider names it: fsn1, eu-south-1, europe-west8-a…")}><Input name="region" defaultValue={a.region} /></Field>
              <Field label={t("Size")} hint="cx32, t3.large, e2-standard-2…"><Input name="size" defaultValue={a.size} /></Field>
              <Field label={t("Base domain template")} hint={t("Host the parent zone in DNS here and the wildcard record is created by itself.")}><Input name="baseDomainTemplate" defaultValue={a.baseDomainTemplate} placeholder="{name}.nodes.example.com" /></Field>
              <Field label={t("Sites per server")}><Input name="workloadsPerNode" type="number" min={1} max={500} defaultValue={a.workloadsPerNode} /></Field>
              <Field label={t("Most servers ever created")} hint={t("A ceiling on the bill.")}><Input name="maxNodes" type="number" min={1} max={200} defaultValue={a.maxNodes} /></Field>
              <Field label={t("Free places kept ready")} hint={t("0 = create a server only when one is needed (the first site waits about five minutes).")}><Input name="minFreeSlots" type="number" min={0} max={500} defaultValue={a.minFreeSlots} /></Field>
              <Field label={t("Remove empty servers after (hours)")} hint={t("0 = never")}><Input name="removeEmptyAfterHours" type="number" min={0} max={720} defaultValue={a.removeEmptyAfterHours} /></Field>
            </div>
            <SubmitButton>{t("Save")}</SubmitButton>
          </ActionForm>
        </div>
      </Card>
      <Card className="mb-6">
        <CardHeader title={t("Monitoring")} description={t("Staff gets an email when a server goes offline, its disk passes 90% or its memory 95%, and again when it recovers. For your own dashboards there is a Prometheus endpoint with servers, services, jobs and unpaid invoices.")} />
        <div className="flex flex-wrap items-center gap-3 p-5">
          <span className="text-sm text-muted">{platform.metricsToken ? t("The metrics endpoint is on.") : t("The metrics endpoint is off.")}</span>
          <ActionForm action={rotateMetricsToken} className=""><SubmitButton size="sm" variant="secondary">{platform.metricsToken ? t("New token") : t("Turn on")}</SubmitButton></ActionForm>
          {platform.metricsToken && <ActionForm action={rotateMetricsToken} className=""><input type="hidden" name="off" value="1" /><SubmitButton size="sm" variant="ghost">{t("Turn off")}</SubmitButton></ActionForm>}
        </div>
      </Card>
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
