import { and, desc, eq } from "drizzle-orm";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { Card, CardHeader, Field, Input, StatusBadge } from "@/components/ui";
import { getDb, schema } from "@/db";
import { getLocale, getT } from "@/i18n";
import { decryptJson } from "@/lib/crypto";
import { formatDateTime } from "@/lib/format";
import { requireWorkload } from "@/platform/access";
import { runTool } from "../../../platform-actions";

export default async function Tools({ params }: { params: Promise<{ id: string }> }) {
  const { workload: w } = await requireWorkload((await params).id);
  const db = await getDb();
  const [t, locale, history] = await Promise.all([
    getT(),
    getLocale(),
    db.select().from(schema.jobs).where(and(eq(schema.jobs.workloadId, w.id), eq(schema.jobs.type, "workload.tool"))).orderBy(desc(schema.jobs.createdAt)).limit(8),
  ]);
  const off = w.status !== "running";
  const simple = [
    { tool: "wp.cache_flush", title: "Clear cache", text: "Flushes the WordPress object cache.", button: "Clear cache" },
    { tool: "wp.debug_on", title: "Debug mode", text: "Turns WP_DEBUG on to show PHP errors. Remember to turn it off.", button: "Enable" },
    { tool: "wp.debug_off", title: "Debug mode off", text: "Turns WP_DEBUG off.", button: "Disable" },
  ];

  return (
    <div className="space-y-6">
      <div className="grid gap-4 md:grid-cols-3">
        {simple.map((s) => (
          <Card key={s.tool} className="flex flex-col p-5">
            <h3 className="font-semibold">{t(s.title)}</h3>
            <p className="mt-1 mb-4 flex-1 text-sm text-muted">{t(s.text)}</p>
            <ActionForm action={runTool}>
              <input type="hidden" name="id" value={w.id} />
              <input type="hidden" name="tool" value={s.tool} />
              <SubmitButton variant="secondary" disabled={off}>{t(s.button)}</SubmitButton>
            </ActionForm>
          </Card>
        ))}
      </div>
      <Card>
        <CardHeader title={t("Search and replace")} description={t("Replaces text in every database table, e.g. after changing domain. Take a backup first.")} />
        <div className="p-5">
          <ActionForm action={runTool}>
            <input type="hidden" name="id" value={w.id} />
            <input type="hidden" name="tool" value="wp.search_replace" />
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={t("Search")}><Input name="search" required placeholder="http://old.example.com" /></Field>
              <Field label={t("Replace with")}><Input name="replace" required placeholder="https://www.example.com" /></Field>
            </div>
            <SubmitButton variant="secondary" disabled={off} confirm={t("Run search and replace on the whole database?")}>{t("Replace")}</SubmitButton>
          </ActionForm>
        </div>
      </Card>
      {history.length > 0 && (
        <Card>
          <CardHeader title={t("Recent runs")} />
          <ul className="divide-y divide-border text-sm">
            {history.map((j) => (
              <li key={j.id} className="flex flex-wrap items-center gap-3 px-5 py-3">
                <StatusBadge status={j.status} label={t(j.status)} />
                <code className="font-mono text-xs">{decryptJson<{ tool?: string }>(j.payload, {}).tool}</code>
                <span className="min-w-0 flex-1 truncate text-muted">{j.error || (String(j.result.output ?? "").includes("aster_login=") ? "" : String(j.result.output ?? "").trim().split("\n").pop())}</span>
                <span className="text-xs text-muted">{formatDateTime(j.createdAt, locale)}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
