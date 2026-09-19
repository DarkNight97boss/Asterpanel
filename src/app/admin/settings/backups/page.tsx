import { desc, eq } from "drizzle-orm";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { AutoRefresh } from "@/components/auto-refresh";
import { Alert, Card, CardHeader, Checkbox, EmptyState, Field, Input, PageHeader, Select, StatusBadge, Table, Td } from "@/components/ui";
import { getDb, schema } from "@/db";
import { getLocale, getT } from "@/i18n";
import { requireAdmin } from "@/lib/auth";
import { formatDateTime } from "@/lib/format";
import { getSettings } from "@/lib/settings";
import { nodeIsOnline } from "@/platform/engine";
import { saveBackups, testOffsiteStorage } from "../../platform-actions";

export const metadata = { title: "Backups" };

export default async function BackupSettings() {
  await requireAdmin();
  const db = await getDb();
  const [t, locale, s, nodes, tests, failed] = await Promise.all([
    getT(),
    getLocale(),
    getSettings("backups"),
    db.select().from(schema.nodes),
    db.select({ job: schema.jobs, node: schema.nodes.name }).from(schema.jobs).innerJoin(schema.nodes, eq(schema.nodes.id, schema.jobs.nodeId)).where(eq(schema.jobs.type, "offsite.test")).orderBy(desc(schema.jobs.createdAt)).limit(5),
    db.select({ b: schema.backups, name: schema.workloads.name }).from(schema.backups).innerJoin(schema.workloads, eq(schema.workloads.id, schema.backups.workloadId)).where(eq(schema.backups.offsite, "failed")).orderBy(desc(schema.backups.createdAt)).limit(10),
  ]);
  const online = nodes.filter(nodeIsOnline);

  return (
    <>
      <AutoRefresh active={tests.some(({ job }) => job.status === "queued" || job.status === "running")} />
      <PageHeader title={t("Backups")} description={t("Retention of the daily backups and an optional copy in S3-compatible object storage.")} />
      <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,42rem)_1fr]">
        <Card>
          <CardHeader title={t("Off-site copies")} description={t("Every backup is also uploaded to your bucket, so it survives the loss of the server. The secret key is encrypted at rest and never shown again.")} />
          <div className="p-5">
            <ActionForm action={saveBackups}>
              <Field label={t("Daily backups kept per service")}><Input name="keepScheduled" type="number" min={1} max={90} defaultValue={s.keepScheduled} className="max-w-32" /></Field>
              <Checkbox name="offsiteEnabled" defaultChecked={s.offsiteEnabled} label={t("Upload every backup to object storage")} />
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label={t("Endpoint")} hint={t("Leave empty for Amazon S3. Examples: Backblaze B2, Wasabi, Cloudflare R2, MinIO.")} className="sm:col-span-2">
                  <Input name="endpoint" type="url" defaultValue={s.endpoint} placeholder="https://s3.eu-central-003.backblazeb2.com" />
                </Field>
                <Field label={t("Bucket")}><Input name="bucket" defaultValue={s.bucket} /></Field>
                <Field label={t("Region")}><Input name="region" defaultValue={s.region} placeholder="eu-central-1" /></Field>
                <Field label={t("Folder inside the bucket")}><Input name="prefix" defaultValue={s.prefix} /></Field>
                <Field label={t("Copy on the server")}>
                  <Select name="keepLocal" defaultValue={s.keepLocal ? "1" : "0"}>
                    <option value="1">{t("Keep it (faster restores)")}</option>
                    <option value="0">{t("Delete it after the upload (saves disk)")}</option>
                  </Select>
                </Field>
                <Field label={t("Access key")}><Input name="accessKey" defaultValue={s.accessKey} autoComplete="off" /></Field>
                <Field label={t("Secret key")}><Input name="secretKey" type="password" autoComplete="off" placeholder={s.secretKey ? "••••••••  (unchanged)" : ""} /></Field>
              </div>
              <SubmitButton>{t("Save")}</SubmitButton>
            </ActionForm>
          </div>
        </Card>

        <div className="space-y-6">
          <Card>
            <CardHeader title={t("Test the connection")} description={t("A server writes, reads back and deletes a small probe object using the saved settings.")} />
            <div className="p-5">
              {online.length ? (
                <ActionForm action={testOffsiteStorage}>
                  <Field label={t("Server")}>
                    <Select name="nodeId">{online.map((n) => <option key={n.id} value={n.id}>{n.name}</option>)}</Select>
                  </Field>
                  <SubmitButton variant="secondary">{t("Run test")}</SubmitButton>
                </ActionForm>
              ) : (
                <Alert tone="warning">{t("No server is online.")}</Alert>
              )}
            </div>
            {tests.length > 0 && (
              <Table head={[t("Date"), t("Server"), t("Result")]}>
                {tests.map(({ job, node }) => (
                  <tr key={job.id}>
                    <Td>{formatDateTime(job.createdAt, locale)}</Td>
                    <Td>{node}</Td>
                    <Td><StatusBadge status={job.status} label={t(job.status)} />{job.error && <span className="mt-1 block max-w-xs text-xs break-words text-danger">{job.error}</span>}</Td>
                  </tr>
                ))}
              </Table>
            )}
          </Card>

          <Card>
            <CardHeader title={t("Failed uploads")} description={t("These backups exist on their server but not in the bucket.")} />
            {failed.length ? (
              <Table head={[t("Date"), t("Service"), t("Error")]}>
                {failed.map(({ b, name }) => (
                  <tr key={b.id}>
                    <Td>{formatDateTime(b.createdAt, locale)}</Td>
                    <Td>{name}</Td>
                    <Td className="max-w-xs text-xs break-words text-danger">{b.offsiteError || "—"}</Td>
                  </tr>
                ))}
              </Table>
            ) : (
              <EmptyState title={t("Nothing here yet")} />
            )}
          </Card>
        </div>
      </div>
    </>
  );
}
