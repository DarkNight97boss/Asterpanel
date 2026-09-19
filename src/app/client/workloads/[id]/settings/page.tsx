import { ActionForm, SubmitButton } from "@/components/action-form";
import { Card, CardHeader, Checkbox, Field, Input, Select, Textarea } from "@/components/ui";
import { getT } from "@/i18n";
import { requireWorkload } from "@/platform/access";
import { PHP_LIMITS, readSecrets } from "@/platform/engine";
import { destroy, saveCronJobs, savePhp, saveSettings } from "../../../platform-actions";

export default async function Settings({ params }: { params: Promise<{ id: string }> }) {
  const { workload: w } = await requireWorkload((await params).id);
  const t = await getT();
  const c = w.config;
  const php = c.php ?? { memoryLimitMb: 256, uploadMaxMb: 64, maxExecutionTime: 60, maxInputVars: 3000 };
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

      {w.type === "wordpress" && (
        <Card>
          <CardHeader title={t("PHP and performance")} description={t("Limits of PHP for this site, and an in-memory object cache that spares the database. Saving restarts the site for a few seconds.")} />
          <div className="p-5">
            <ActionForm action={savePhp}>
              <input type="hidden" name="id" value={w.id} />
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                <Field label={t("Memory limit (MB)")} hint={t("At most half of the site's RAM.")}><Input name="memoryLimitMb" type="number" min={PHP_LIMITS.memoryLimitMb[0]} max={PHP_LIMITS.memoryLimitMb[1]} defaultValue={php.memoryLimitMb} /></Field>
                <Field label={t("Largest upload (MB)")}><Input name="uploadMaxMb" type="number" min={PHP_LIMITS.uploadMaxMb[0]} max={PHP_LIMITS.uploadMaxMb[1]} defaultValue={php.uploadMaxMb} /></Field>
                <Field label={t("Longest request (seconds)")}><Input name="maxExecutionTime" type="number" min={PHP_LIMITS.maxExecutionTime[0]} max={PHP_LIMITS.maxExecutionTime[1]} defaultValue={php.maxExecutionTime} /></Field>
                <Field label="max_input_vars"><Input name="maxInputVars" type="number" min={PHP_LIMITS.maxInputVars[0]} max={PHP_LIMITS.maxInputVars[1]} defaultValue={php.maxInputVars} /></Field>
              </div>
              <Checkbox name="objectCache" defaultChecked={!!c.objectCache} label={t("Redis object cache (installs and configures the Redis Object Cache plugin)")} />
              <SubmitButton variant="secondary">{t("Save")}</SubmitButton>
            </ActionForm>
          </div>
        </Card>
      )}

      {w.type === "app" && w.environment === "live" && (
        <Card>
          <CardHeader title={t("Scheduled jobs")} description={t("Commands run inside your app's container, with its environment variables. Times are UTC. A job that is still running is not started again on top of itself; output shows up in Logs.")} />
          <div className="p-5">
            <ActionForm action={saveCronJobs}>
              <input type="hidden" name="id" value={w.id} />
              <Field label={t("One job per line: schedule, then command")} hint={t("Five cron fields or @hourly, @daily, @weekly, @monthly. Up to 5 jobs.")}>
                <Textarea name="crons" rows={5} className="font-mono text-xs" defaultValue={(w.config.crons ?? []).map((j) => `${j.schedule} ${j.command}`).join("\n")} placeholder={"*/15 * * * * node scripts/sync.js\n@daily php artisan schedule:run"} />
              </Field>
              <SubmitButton variant="secondary">{t("Save")}</SubmitButton>
            </ActionForm>
          </div>
        </Card>
      )}

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
