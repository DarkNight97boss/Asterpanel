import { desc, eq } from "drizzle-orm";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { Card, CardHeader, EmptyState, StatusBadge } from "@/components/ui";
import { getDb, schema } from "@/db";
import { getLocale, getT } from "@/i18n";
import { formatDateTime } from "@/lib/format";
import { baseUrl } from "@/lib/url";
import { requireWorkload } from "@/platform/access";
import { deploy } from "../../../platform-actions";

export default async function Deployments({ params }: { params: Promise<{ id: string }> }) {
  const { workload: w } = await requireWorkload((await params).id);
  const db = await getDb();
  const [t, locale, origin, deployments, jobs] = await Promise.all([
    getT(),
    getLocale(),
    baseUrl(),
    db.select().from(schema.deployments).where(eq(schema.deployments.workloadId, w.id)).orderBy(desc(schema.deployments.createdAt)).limit(30),
    db.select({ deploymentId: schema.jobs.deploymentId, log: schema.jobs.log, error: schema.jobs.error, status: schema.jobs.status }).from(schema.jobs).where(eq(schema.jobs.workloadId, w.id)).orderBy(desc(schema.jobs.createdAt)).limit(60),
  ]);
  const TRIGGER: Record<string, string> = { manual: "Manual", push: "Git push", create: "First deploy" };

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader
          title={t("Deploy")}
          description={`${w.config.repoUrl} · ${w.config.branch ?? "main"}`}
          action={
            <ActionForm action={deploy} className="">
              <input type="hidden" name="id" value={w.id} />
              <SubmitButton disabled={w.status === "creating" || w.status === "suspended"}>{t("Deploy now")}</SubmitButton>
            </ActionForm>
          }
        />
        <div className="space-y-2 p-5 text-sm">
          <p className="text-muted">{t("Deploy on every push: add this URL as a webhook (POST) in your Git provider.")}</p>
          <code className="block overflow-x-auto rounded-theme border border-border bg-subtle p-3 font-mono text-xs select-all">{origin}/api/hooks/deploy/{w.id}/{w.deployHookToken}</code>
        </div>
      </Card>

      <Card>
        {deployments.length ? (
          <ul className="divide-y divide-border">
            {deployments.map((d, i) => {
              const job = jobs.find((j) => j.deploymentId === d.id);
              const running = job?.status === "running" || job?.status === "queued";
              return (
                <li key={d.id}>
                  <details open={i === 0 && (running || d.status === "failed")} className="group">
                    <summary className="flex cursor-pointer list-none flex-wrap items-center gap-3 px-5 py-3.5 text-sm">
                      <StatusBadge status={running ? "building" : d.status} label={t(running ? "building" : d.status)} />
                      <code className="font-mono text-xs">{d.commitSha.slice(0, 7) || "·······"}</code>
                      <span className="min-w-0 flex-1 truncate">{d.commitMessage || "—"}</span>
                      <span className="text-xs text-muted">{t(TRIGGER[d.trigger])} · {formatDateTime(d.createdAt, locale)}</span>
                    </summary>
                    <pre className="max-h-96 overflow-auto bg-ink px-5 py-4 font-mono text-xs leading-relaxed text-ink-fg">{job?.log || t("No output yet.")}</pre>
                  </details>
                </li>
              );
            })}
          </ul>
        ) : (
          <EmptyState title={t("No deployments yet")} />
        )}
      </Card>
    </div>
  );
}
