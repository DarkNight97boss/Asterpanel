import { and, eq } from "drizzle-orm";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { AutoRefresh } from "@/components/auto-refresh";
import { Alert, Card, EmptyState, Input, PageHeader, Table, Td, Textarea } from "@/components/ui";
import { getDb, schema } from "@/db";
import { getLocale, getT } from "@/i18n";
import { formatDateTime } from "@/lib/format";
import { requireWorkload } from "@/platform/access";
import type { FilesResult } from "@/platform/protocol";
import { filesAction } from "../../../platform-actions";

/** A button that looks like a link: every navigation is a job, so it is a POST. */
function Go({ id, action, path, children, className = "text-left hover:text-link hover:underline", confirm }: { id: string; action: string; path: string; children: React.ReactNode; className?: string; confirm?: string }) {
  return (
    <ActionForm action={filesAction} className="inline">
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="action" value={action} />
      <input type="hidden" name="path" value={path} />
      <SubmitButton variant="ghost" size="sm" className={`!h-auto !p-0 !font-normal ${className}`} confirm={confirm}>{children}</SubmitButton>
    </ActionForm>
  );
}

export default async function Files({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ job?: string }> }) {
  const { workload: w } = await requireWorkload((await params).id);
  const jobId = (await searchParams).job ?? "";
  const db = await getDb();
  const [t, locale] = await Promise.all([getT(), getLocale()]);
  const [job] = /^[0-9a-f-]{36}$/i.test(jobId)
    ? await db.select().from(schema.jobs).where(and(eq(schema.jobs.id, jobId), eq(schema.jobs.workloadId, w.id), eq(schema.jobs.type, "workload.files")))
    : [];
  const pending = job?.status === "queued" || job?.status === "running";
  let result: FilesResult | null = null;
  if (job?.status === "succeeded" && typeof job.result.output === "string") {
    try {
      result = JSON.parse(job.result.output) as FilesResult;
    } catch {}
  }
  const here = result && result.kind !== "done" ? result.path : "";
  const dir = result?.kind === "file" ? here.split("/").slice(0, -1).join("/") : here;
  const crumbs = dir ? dir.split("/") : [];
  const size = (n: number) => (n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : n > 1e3 ? `${Math.round(n / 1e3)} KB` : `${n} B`);

  return (
    <>
      <AutoRefresh active={pending} intervalMs={1200} />
      <PageHeader title={t("Files")} description={t("Browse and edit your site's files. For uploads and large files use SFTP.")} />
      {job?.status === "failed" && <div className="mb-5"><Alert tone="danger">{job.error}</Alert></div>}

      <Card>
        <div className="flex flex-wrap items-center gap-1.5 border-b border-border px-6 py-4 font-mono text-sm">
          <Go id={w.id} action="list" path="">site</Go>
          {crumbs.map((part, i) => (
            <span key={i} className="flex items-center gap-1.5">
              <span className="text-muted">/</span>
              <Go id={w.id} action="list" path={crumbs.slice(0, i + 1).join("/")}>{part}</Go>
            </span>
          ))}
          {result?.kind === "file" && <><span className="text-muted">/</span><span className="font-medium text-fg">{here.split("/").pop()}</span></>}
          {pending && <span className="ml-3 inline-block size-3 animate-spin rounded-full border-2 border-current border-t-transparent text-muted" />}
        </div>

        {!result || result.kind === "done" ? (
          <EmptyState title={pending ? t("Working…") : t("Open the file manager")} action={!pending && <Go id={w.id} action="list" path="" className="rounded-theme bg-primary !px-4 !py-2.5 text-primary-fg">{t("Browse files")}</Go>} />
        ) : result.kind === "list" ? (
          <>
            {result.entries.length ? (
              <Table head={[t("Name"), t("Size"), t("Modified"), ""]}>
                {[...result.entries].sort((a, b) => Number(b.type === "dir") - Number(a.type === "dir") || a.name.localeCompare(b.name)).map((e) => {
                  const path = dir ? `${dir}/${e.name}` : e.name;
                  return (
                    <tr key={e.name}>
                      <Td className="font-mono text-xs">
                        <span aria-hidden className="mr-2 text-muted">{e.type === "dir" ? "▸" : "·"}</span>
                        {e.type === "link" ? e.name : <Go id={w.id} action={e.type === "dir" ? "list" : "read"} path={path}>{e.name}{e.type === "dir" && "/"}</Go>}
                      </Td>
                      <Td className="text-body">{e.type === "dir" ? "—" : size(e.size)}</Td>
                      <Td className="text-body">{formatDateTime(new Date(e.mtime * 1000), locale)}</Td>
                      <Td className="text-right"><Go id={w.id} action="delete" path={path} className="text-muted hover:text-danger" confirm={t("Delete “{name}”? This cannot be undone.", { name: e.name })}>{t("Delete")}</Go></Td>
                    </tr>
                  );
                })}
              </Table>
            ) : (
              <EmptyState title={t("This folder is empty")} />
            )}
            <div className="grid gap-4 border-t border-border p-6 md:grid-cols-2">
              {([["mkdir", t("New folder"), "uploads-2"], ["write", t("New file"), "robots.txt"]] as const).map(([action, label, placeholder]) => (
                <ActionForm key={action} action={filesAction} className="flex items-start gap-2">
                  <input type="hidden" name="id" value={w.id} />
                  <input type="hidden" name="action" value={action} />
                  <input type="hidden" name="dir" value={dir} />
                  <Input name="name" placeholder={placeholder} required aria-label={label} />
                  <SubmitButton variant="secondary">{label}</SubmitButton>
                </ActionForm>
              ))}
            </div>
          </>
        ) : result.binary ? (
          <EmptyState title={t("This file is not text")} description={t("Download it over SFTP to open it.")} />
        ) : (
          <div className="p-6">
            <ActionForm action={filesAction}>
              <input type="hidden" name="id" value={w.id} />
              <input type="hidden" name="action" value="write" />
              <input type="hidden" name="path" value={here} />
              <Textarea name="content" defaultValue={result.content} rows={24} spellCheck={false} className="font-mono text-xs leading-relaxed" readOnly={result.truncated} />
              {result.truncated ? <Alert tone="warning">{t("This file is too large to edit here. Use SFTP.")}</Alert> : <SubmitButton confirm={t("Save changes to this file? Take a backup first if you are unsure.")}>{t("Save file")}</SubmitButton>}
            </ActionForm>
          </div>
        )}
      </Card>
    </>
  );
}
