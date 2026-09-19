import { ActionForm, SubmitButton } from "@/components/action-form";
import { Card, CardHeader, Checkbox, Field, Input, PageHeader, Textarea } from "@/components/ui";
import { getT } from "@/i18n";
import { requireAdmin } from "@/lib/auth";
import { getSettings } from "@/lib/settings";
import { baseUrl } from "@/lib/url";
import { saveGithub } from "../../platform-actions";

export const metadata = { title: "GitHub" };

const Row = ({ k, v }: { k: string; v: string }) => (
  <li className="grid gap-1 sm:grid-cols-[14rem_1fr]"><span className="text-muted">{k}</span><code className="font-mono text-xs break-all select-all">{v}</code></li>
);

export default async function GithubSettings() {
  await requireAdmin();
  const [t, s, origin] = await Promise.all([getT(), getSettings("github"), baseUrl()]);
  const kept = (v: string) => (v ? "••••••••  (unchanged)" : "");
  return (
    <>
      <PageHeader title="GitHub" description={t("Your own GitHub App: customers install it on their repositories to deploy on push, without webhooks or access tokens, and see the result on every commit.")} />
      <div className="grid items-start gap-6 xl:grid-cols-2">
        <Card>
          <CardHeader title={t("1. Register the app on GitHub")} description={t("Settings → Developer settings → GitHub Apps → New GitHub App, with these values.")} />
          <ul className="space-y-3 p-5 text-sm">
            <Row k={t("Homepage URL")} v={origin} />
            <Row k={t("Callback URL")} v={`${origin}/api/github/setup`} />
            <Row k={t("Setup URL")} v={`${origin}/api/github/setup`} />
            <Row k={t("Webhook URL")} v={`${origin}/api/webhooks/github`} />
            <Row k={t("Tick")} v="Request user authorization (OAuth) during installation" />
            <Row k={t("Repository permissions")} v="Contents: Read-only · Commit statuses: Read and write · Metadata: Read-only" />
            <Row k={t("Subscribe to events")} v="Push" />
            <Row k={t("Where can it be installed")} v="Any account" />
          </ul>
        </Card>
        <Card>
          <CardHeader title={t("2. Paste what GitHub gives you")} description={t("Secrets are encrypted at rest and never shown again.")} />
          <div className="p-5">
            <ActionForm action={saveGithub}>
              <Checkbox name="enabled" defaultChecked={s.enabled} label={t("Offer “Connect GitHub” to customers")} />
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="App ID"><Input name="appId" defaultValue={s.appId} inputMode="numeric" /></Field>
                <Field label={t("App name")} hint="github.com/apps/<name>"><Input name="slug" defaultValue={s.slug} /></Field>
                <Field label="Client ID"><Input name="clientId" defaultValue={s.clientId} autoComplete="off" /></Field>
                <Field label="Client secret"><Input name="clientSecret" type="password" autoComplete="off" placeholder={kept(s.clientSecret)} /></Field>
                <Field label={t("Webhook secret")} className="sm:col-span-2"><Input name="webhookSecret" type="password" autoComplete="off" placeholder={kept(s.webhookSecret)} /></Field>
                <Field label={t("Private key (.pem)")} className="sm:col-span-2"><Textarea name="privateKey" rows={5} autoComplete="off" className="font-mono text-xs" placeholder={kept(s.privateKey) || "-----BEGIN RSA PRIVATE KEY-----"} /></Field>
              </div>
              <SubmitButton>{t("Save")}</SubmitButton>
            </ActionForm>
          </div>
        </Card>
      </div>
    </>
  );
}
