import { ActionForm, SubmitButton } from "@/components/action-form";
import { Alert, Card, CardHeader, EmptyState, Field, Input, PageHeader, StatusBadge, Table, Td } from "@/components/ui";
import { getLocale, getT } from "@/i18n";
import { formatDateTime } from "@/lib/format";
import { requireWorkload } from "@/platform/access";
import { listMigrations } from "@/platform/engine";
import { migrate } from "../../../platform-actions";

export default async function Migrate({ params }: { params: Promise<{ id: string }> }) {
  const { workload: w, canManage } = await requireWorkload((await params).id);
  const [t, locale, runs] = await Promise.all([getT(), getLocale(), listMigrations(w.id)]);
  const target = w.domains[0]?.hostname;

  return (
    <>
      <PageHeader title={t("Migration")} description={t("Bring an existing WordPress site here. Files and database are copied, then every link is rewritten to {domain}.", { domain: target ?? "" })} />
      <div className="space-y-6">
        <Alert tone="warning">{t("The migration replaces everything on this site. A backup is taken first, so you can go back from the Backups page. The old site is only read, never changed.")}</Alert>

        {canManage && w.type === "wordpress" && (
          <div className="grid items-start gap-6 xl:grid-cols-2">
            <Card>
              <CardHeader title={t("From the old server (SSH)")} description={t("We copy the files with rsync and export the database with the details found in its wp-config.php. The password is used once and not kept.")} />
              <div className="p-5">
                <ActionForm action={migrate}>
                  <input type="hidden" name="id" value={w.id} />
                  <input type="hidden" name="type" value="ssh" />
                  <div className="grid gap-4 sm:grid-cols-[1fr_7rem]">
                    <Field label={t("Host")}><Input name="host" required placeholder="ssh.old-host.com" /></Field>
                    <Field label={t("Port")}><Input name="port" type="number" min={1} max={65535} defaultValue={22} /></Field>
                  </div>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <Field label={t("Username")}><Input name="user" required autoComplete="off" /></Field>
                    <Field label={t("Password")}><Input name="password" type="password" required autoComplete="off" /></Field>
                  </div>
                  <Field label={t("WordPress folder")} hint={t("The folder that contains wp-config.php, for example public_html")}><Input name="path" required placeholder="public_html" /></Field>
                  <SubmitButton>{t("Start migration")}</SubmitButton>
                </ActionForm>
              </div>
            </Card>

            <Card>
              <CardHeader title={t("From a backup archive")} description={t("A .zip or .tar.gz with the site's files and one database export (.sql or .sql.gz) inside, as produced by most hosting panels and backup plugins.")} />
              <div className="p-5">
                <ActionForm action={migrate}>
                  <input type="hidden" name="id" value={w.id} />
                  <input type="hidden" name="type" value="archive" />
                  <Field label={t("Link to the archive")} hint={t("Must start with https:// and be downloadable without signing in. Up to 20 GB.")}><Input name="url" type="url" required placeholder="https://example.com/backup.zip" /></Field>
                  <SubmitButton>{t("Start migration")}</SubmitButton>
                </ActionForm>
              </div>
            </Card>
          </div>
        )}

        <Card>
          <CardHeader title={t("Migration history")} />
          {runs.length ? (
            <Table head={[t("Date"), t("From"), t("Result"), t("Details")]}>
              {runs.map((r) => (
                <tr key={r.id}>
                  <Td>{formatDateTime(r.createdAt, locale)}</Td>
                  <Td className="text-body">{r.label || "—"}</Td>
                  <Td><StatusBadge status={r.status} label={t(r.status)} /></Td>
                  <Td className="text-sm">
                    {r.error && <span className="block max-w-md break-words text-danger">{r.error}</span>}
                    {r.summary.oldUrl && <span className="block text-body">{r.summary.oldUrl} → https://{target}</span>}
                    {r.summary.wpVersion && <span className="block text-xs text-muted">WordPress {r.summary.wpVersion} · {t("table prefix")} {r.summary.tablePrefix}</span>}
                    {r.log && (
                      <details className="mt-1">
                        <summary className="cursor-pointer text-xs text-link">{t("Log")}</summary>
                        <pre className="mt-2 max-h-64 max-w-xl overflow-auto rounded-theme bg-subtle p-3 text-xs whitespace-pre-wrap">{r.log}</pre>
                      </details>
                    )}
                  </Td>
                </tr>
              ))}
            </Table>
          ) : (
            <EmptyState title={t("Nothing here yet")} />
          )}
        </Card>
      </div>
    </>
  );
}
