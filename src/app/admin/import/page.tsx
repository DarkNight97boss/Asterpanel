import { ActionForm, SubmitButton } from "@/components/action-form";
import { Alert, Card, CardHeader, Checkbox, Field, Input, PageHeader } from "@/components/ui";
import { getLocale, getT } from "@/i18n";
import { requireAdmin } from "@/lib/auth";
import { formatDateTime } from "@/lib/format";
import type { ImportReport } from "@/lib/import";
import { getSettings } from "@/lib/settings";
import { importNow, saveWhmcs } from "./actions";

export const metadata = { title: "Import" };

export default async function Import() {
  await requireAdmin();
  const [t, locale, s] = await Promise.all([getT(), getLocale(), getSettings("whmcs")]);
  let last: (ImportReport & { at: string; applied: boolean }) | null = null;
  try {
    last = s.lastReport ? JSON.parse(s.lastReport) : null;
  } catch {
    last = null;
  }
  const connected = !!(s.url && s.identifier && s.secret);
  const line = (label: string, n: { created: number; existing: number }) => <li><span className="font-medium">{label}:</span> {t("{new} new, {old} already here", { new: n.created, old: n.existing })}</li>;

  return (
    <>
      <PageHeader title={t("Import")} description={t("Move customers, active services and domains in from WHMCS. Nothing is provisioned, charged or emailed: imported services are records that start renewing here from their next due date. Running it again adds nothing twice.")} />
      <div className="grid items-start gap-6 xl:grid-cols-2">
        <Card>
          <CardHeader title="WHMCS" description={t("In WHMCS: Setup → Staff Management → Manage API Credentials, with a role that allows GetClients, GetClientsDetails, GetClientsProducts and GetClientsDomains. Allow this server's IP under General Settings → Security. The secret is encrypted at rest.")} />
          <div className="p-5">
            <ActionForm action={saveWhmcs}>
              <Field label={t("WHMCS address")}><Input name="url" type="url" defaultValue={s.url} placeholder="https://billing.example.com" required /></Field>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Identifier"><Input name="identifier" defaultValue={s.identifier} autoComplete="off" required /></Field>
                <Field label="Secret"><Input name="secret" type="password" autoComplete="off" placeholder={s.secret ? "••••••••  (unchanged)" : ""} /></Field>
              </div>
              <div className="flex flex-wrap gap-3"><SubmitButton>{t("Connect")}</SubmitButton>{connected && <SubmitButton name="forget" value="1" variant="ghost">{t("Forget these credentials")}</SubmitButton>}</div>
            </ActionForm>
          </div>
        </Card>

        <Card>
          <CardHeader title={t("Run")} description={t("Always look at the preview first. Customers are matched by email and get no password: they set one through “Forgot your password?”. Invoice history is not imported.")} />
          <div className="space-y-4 p-5">
            <ActionForm action={importNow}>
              <Field label={t("…or a file in the import format (JSON)")} hint={t("For other systems: { source, clients[], services[], domains[] }. Amounts in cents.")}><input type="file" name="file" accept="application/json,.json" className="block w-full text-sm" /></Field>
              <Checkbox name="confirm" label={t("I have read the preview: create these customers, services and domains")} />
              <div className="flex flex-wrap gap-3">
                <SubmitButton name="mode" value="preview" variant="secondary">{t("Preview")}</SubmitButton>
                <SubmitButton name="mode" value="apply">{t("Import")}</SubmitButton>
              </div>
            </ActionForm>
          </div>
        </Card>

        {last && (
          <Card className="xl:col-span-2">
            <CardHeader title={last.applied ? t("Last import") : t("Preview")} description={formatDateTime(new Date(last.at), locale)} />
            <div className="space-y-4 p-5 pt-0 text-sm">
              {!last.applied && <Alert tone="info">{t("Nothing has been written yet.")}</Alert>}
              <ul className="space-y-1">{line(t("Customers"), last.clients)}{line(t("Services"), last.services)}{line(t("Domains"), last.domains)}</ul>
              {last.products.length > 0 && <p><span className="font-medium">{t("Products created as hidden, manual products")}:</span> {last.products.join(", ")}</p>}
              {last.skipped.length > 0 && <details><summary className="cursor-pointer font-medium">{t("Skipped")} ({last.skipped.length})</summary><ul className="mt-2 list-disc space-y-0.5 pl-5 text-body">{last.skipped.map((x, i) => <li key={i}>{x}</li>)}</ul></details>}
              {last.warnings.length > 0 && <details><summary className="cursor-pointer font-medium">{t("Warnings")} ({last.warnings.length})</summary><ul className="mt-2 list-disc space-y-0.5 pl-5 text-body">{last.warnings.map((x, i) => <li key={i}>{x}</li>)}</ul></details>}
            </div>
          </Card>
        )}
      </div>
    </>
  );
}
