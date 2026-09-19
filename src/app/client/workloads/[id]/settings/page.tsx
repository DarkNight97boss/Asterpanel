import { ActionForm, SubmitButton } from "@/components/action-form";
import { Card, CardHeader, Field, Input, Select, Textarea } from "@/components/ui";
import { getT } from "@/i18n";
import { requireWorkload } from "@/platform/access";
import { readSecrets } from "@/platform/engine";
import { destroy, saveSettings } from "../../../platform-actions";

export default async function Settings({ params }: { params: Promise<{ id: string }> }) {
  const { workload: w } = await requireWorkload((await params).id);
  const t = await getT();
  const c = w.config;
  const env = Object.entries(readSecrets(w).env ?? {}).map(([k, v]) => `${k}=${v}`).join("\n");
  const git = w.type === "app" || w.type === "static";

  return (
    <div className="max-w-3xl space-y-6">
      <Card>
        <CardHeader title={t("Settings")} description={git ? t("Changes are applied with a restart; repository changes take effect on the next deploy.") : undefined} />
        <div className="p-5">
          <ActionForm action={saveSettings}>
            <input type="hidden" name="id" value={w.id} />
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={t("Name")}><Input name="name" defaultValue={w.name} required minLength={2} maxLength={60} /></Field>
              <Field label={t("Labels")} hint={t("Separated by commas. Use them to group and filter your services.")}><Input name="labels" defaultValue={w.labels.join(", ")} placeholder="client-acme, e-commerce" /></Field>
              {w.type === "wordpress" && (
                <Field label={t("PHP version")} hint={t("The site restarts on the new version.")}>
                  <Select name="phpVersion" defaultValue={c.phpVersion ?? "8.3"}>{["8.4", "8.3", "8.2", "8.1"].map((v) => <option key={v}>{v}</option>)}</Select>
                </Field>
              )}
              {git && (
                <>
                  <Field label={t("Branch")}><Input name="branch" defaultValue={c.branch ?? "main"} required /></Field>
                  <Field label={t("Git repository (HTTPS)")} className="sm:col-span-2"><Input name="repoUrl" type="url" defaultValue={c.repoUrl} required /></Field>
                  {w.type === "static" ? (
                    <>
                      <Field label={t("Build command")}><Input name="buildCommand" defaultValue={c.buildCommand} /></Field>
                      <Field label={t("Output directory")}><Input name="outputDir" defaultValue={c.outputDir} /></Field>
                    </>
                  ) : (
                    <Field label={t("Port")}><Input name="port" type="number" defaultValue={c.port ?? 8080} /></Field>
                  )}
                  <Field label={t("Environment variables")} hint="KEY=value" className="sm:col-span-2">
                    <Textarea name="env" rows={6} defaultValue={env} className="font-mono" spellCheck={false} />
                  </Field>
                </>
              )}
            </div>
            <SubmitButton>{t("Save")}</SubmitButton>
          </ActionForm>
        </div>
      </Card>

      {w.environment === "live" && (
        <Card className="border-danger/40">
          <CardHeader title={t("Danger zone")} description={t("Deletes the service with all its files, databases, backups and staging. The plan is cancelled. This cannot be undone.")} />
          <div className="p-5">
            <ActionForm action={destroy} className="flex max-w-xl flex-wrap items-start gap-3">
              <input type="hidden" name="id" value={w.id} />
              <Input name="confirm" placeholder={t("Type “{name}” to confirm", { name: w.name })} required className="flex-1" autoComplete="off" />
              <SubmitButton variant="danger">{t("Delete forever")}</SubmitButton>
            </ActionForm>
          </div>
        </Card>
      )}
    </div>
  );
}
