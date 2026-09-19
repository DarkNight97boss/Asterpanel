import { and, eq } from "drizzle-orm";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { AutoRefresh } from "@/components/auto-refresh";
import { Alert, Card, Checkbox, DataField, PageHeader, Table, Td, Textarea } from "@/components/ui";
import { getDb, schema } from "@/db";
import { getT } from "@/i18n";
import { decryptJson } from "@/lib/crypto";
import { requireWorkload } from "@/platform/access";
import { readSecrets } from "@/platform/engine";
import type { DbResult } from "@/platform/protocol";
import { dbConsole } from "../../../platform-actions";

export default async function Database({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ job?: string }> }) {
  const { workload: w } = await requireWorkload((await params).id);
  const jobId = (await searchParams).job ?? "";
  const db = await getDb();
  const t = await getT();
  const [job] = /^[0-9a-f-]{36}$/i.test(jobId)
    ? await db.select().from(schema.jobs).where(and(eq(schema.jobs.id, jobId), eq(schema.jobs.workloadId, w.id), eq(schema.jobs.type, "workload.db")))
    : [];
  const pending = job?.status === "queued" || job?.status === "running";
  const lastSql = job ? (decryptJson<{ sql?: string }>(job.payload, {}).sql ?? "") : "";
  let result: DbResult | null = null;
  if (job?.status === "succeeded" && typeof job.result.output === "string") {
    try {
      result = JSON.parse(job.result.output) as DbResult;
    } catch {}
  }

  const wp = w.type === "wordpress";
  const secrets = readSecrets(w);
  const postgres = w.config.engine === "postgres";
  const details: [string, string][] = [
    [t("Internal host"), wp ? `aster-${w.slug}-db` : (w.runtime.internalHost ?? `aster-${w.slug}`)],
    [t("Port"), postgres ? "5432" : "3306"],
    [t("Database name"), wp ? "wordpress" : (w.runtime.dbName ?? "—")],
    [t("Username"), wp ? "wordpress" : (w.runtime.dbUser ?? "—")],
  ];

  return (
    <>
      <AutoRefresh active={pending} intervalMs={1500} />
      <PageHeader title={t("Database")} description={wp ? "MariaDB" : postgres ? "PostgreSQL" : "MariaDB (MySQL)"} />
      <div className="space-y-6">
        <Card className="p-6">
          <h2 className="mb-5 text-xl font-medium">{t("Database access")}</h2>
          <div className="grid gap-x-6 gap-y-5 sm:grid-cols-2 lg:grid-cols-5">
            {details.map(([label, value]) => <DataField key={label} label={label}><span className="select-all">{value}</span></DataField>)}
            <DataField label={t("Password")}>
              <details className="group"><summary className="cursor-pointer list-none text-link group-open:hidden">{t("Show")}</summary><code className="font-mono text-xs select-all">{secrets.dbPassword}</code></details>
            </DataField>
          </div>
          <p className="mt-5 text-sm text-muted">{t("The database is only reachable from your own services on this server, never from the internet.")}</p>
        </Card>

        <Card className="p-6">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-xl font-medium">{t("SQL console")}</h2>
            <ActionForm action={dbConsole} className="">
              <input type="hidden" name="id" value={w.id} />
              <input type="hidden" name="action" value="tables" />
              <SubmitButton variant="secondary" size="sm" disabled={pending || w.status !== "running"}>{t("List tables")}</SubmitButton>
            </ActionForm>
          </div>
          <ActionForm action={dbConsole}>
            <input type="hidden" name="id" value={w.id} />
            <Textarea name="sql" rows={5} required defaultValue={lastSql} spellCheck={false} className="font-mono" placeholder={wp ? "SELECT ID, post_title, post_status FROM wp_posts ORDER BY ID DESC LIMIT 20" : "SELECT * FROM my_table LIMIT 20"} />
            <div className="flex flex-wrap items-center justify-between gap-4">
              <Checkbox name="confirmWrite" label={t("I understand this statement may change or delete data")} />
              <SubmitButton disabled={pending || w.status !== "running"}>{pending ? t("Working…") : t("Run")}</SubmitButton>
            </div>
            <p className="text-xs text-muted">{t("One statement at a time, 30 second limit, first 200 rows shown. Every statement is recorded in the activity log. Take a backup before changing data.")}</p>
          </ActionForm>
        </Card>

        {job?.status === "failed" && <Alert tone="danger">{job.error}</Alert>}
        {result && (
          <Card>
            {result.message && !result.columns.length ? (
              <p className="p-6 text-sm text-success">{result.message}</p>
            ) : (
              <>
                <Table head={result.columns}>
                  {result.rows.map((row, i) => (
                    <tr key={i}>
                      {row.map((cell, j) => <Td key={j} className="max-w-xs truncate font-mono text-xs" title={cell ?? undefined}>{cell === null ? <span className="text-muted italic">NULL</span> : cell}</Td>)}
                    </tr>
                  ))}
                </Table>
                <p className="border-t border-border px-6 py-3 text-xs text-muted">{t("{n} rows", { n: result.rows.length })}{result.truncated && ` · ${t("more rows were not shown")}`}</p>
              </>
            )}
          </Card>
        )}
      </div>
    </>
  );
}
