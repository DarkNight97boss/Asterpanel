import { desc, eq } from "drizzle-orm";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { Button, Card, CardHeader, EmptyState, StatusBadge } from "@/components/ui";
import { getDb, schema } from "@/db";
import { getLocale, getT } from "@/i18n";
import { formatDateTime } from "@/lib/format";
import { baseUrl } from "@/lib/url";
import { requireWorkload } from "@/platform/access";
import Link from "next/link";
import { githubRepoOf } from "@/lib/github";
import { getSettings } from "@/lib/settings";
import { MAX_PREVIEWS, previewsOf, rollbackCandidates } from "@/platform/engine";
import { connectGithub, deploy, disconnectGithubRepo, removePreview, rollback, togglePreviews } from "../../../platform-actions";

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
  const gh = await getSettings("github");
  const github = gh.enabled && !!gh.slug && w.environment === "live" && !!githubRepoOf(w.config.repoUrl ?? "");
  const previews = w.environment === "live" ? await previewsOf(w.id) : [];
  const TRIGGER: Record<string, string> = { manual: "Manual", push: "Git push", create: "First deploy", rollback: "Rollback" };
  // The newest kept build is what is live now: rolling back to it would change nothing.
  const canRollBack = new Set(w.type === "app" ? (await rollbackCandidates(w.id)).slice(1).map((d) => d.id) : []);

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
          {github && (
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-theme border border-border p-4">
              {w.githubInstallationId ? (
                <>
                  <span><strong className="font-medium">GitHub</strong> · {w.githubRepo} — {t("pushes deploy by themselves, private repositories need no token, and every commit shows the result.")}</span>
                  <ActionForm action={disconnectGithubRepo} className=""><input type="hidden" name="id" value={w.id} /><SubmitButton size="sm" variant="ghost">{t("Disconnect")}</SubmitButton></ActionForm>
                </>
              ) : (
                <>
                  <span className="text-muted">{t("Connect the repository on GitHub: no webhook to set up, no access token to keep, and the deploy result next to each commit.")}</span>
                  <form action={connectGithub}><input type="hidden" name="id" value={w.id} /><Button variant="secondary">{t("Connect GitHub")}</Button></form>
                </>
              )}
            </div>
          )}
          <p className="text-muted">{t("Deploy on every push: add this URL as a webhook (POST) in your Git provider.")}</p>
          <code className="block overflow-x-auto rounded-theme border border-border bg-subtle p-3 font-mono text-xs select-all">{origin}/api/hooks/deploy/{w.id}/{w.deployHookToken}</code>
        </div>
      </Card>

      {w.environment === "live" && (
        <Card>
          <CardHeader
            title={t("Preview environments")}
            description={t("Every other branch you push gets its own copy of the app at its own address, rebuilt on each push and removed when the branch is deleted. Up to {n} at a time. Needs the webhook above with the push event.", { n: MAX_PREVIEWS })}
            action={
              <ActionForm action={togglePreviews} className="">
                <input type="hidden" name="id" value={w.id} />
                <input type="hidden" name="enabled" value={w.config.previews ? "0" : "1"} />
                <SubmitButton variant="secondary">{w.config.previews ? t("Turn off") : t("Turn on")}</SubmitButton>
              </ActionForm>
            }
          />
          {w.config.previews && <p className="px-5 pb-4 text-xs text-muted">{t("Previews run with the same environment variables as the app, database credentials included. Turn them on only for repositories where every branch is trusted.")}</p>}
          {previews.length > 0 && (
            <ul className="divide-y divide-border border-t border-border">
              {previews.map((p) => (
                <li key={p.id} className="flex flex-wrap items-center gap-3 px-5 py-3 text-sm">
                  <StatusBadge status={p.status} label={t(p.status)} />
                  <code className="font-mono text-xs">{p.config.branch}</code>
                  <Link href={`/client/workloads/${p.id}/deployments`} className="text-link">{t("Deployments")}</Link>
                  <span className="ml-auto" />
                  <ActionForm action={removePreview} className="">
                    <input type="hidden" name="id" value={w.id} />
                    <input type="hidden" name="previewId" value={p.id} />
                    <SubmitButton size="sm" variant="ghost">{t("Remove")}</SubmitButton>
                  </ActionForm>
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}

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
                    {canRollBack.has(d.id) && w.status !== "suspended" && (
                      <div className="flex items-center justify-between gap-4 border-t border-border bg-subtle px-5 py-3 text-sm">
                        <span className="text-muted">{t("Put this version back in service, without rebuilding. Switches with no downtime.")}</span>
                        <ActionForm action={rollback} className="">
                          <input type="hidden" name="id" value={w.id} />
                          <input type="hidden" name="deploymentId" value={d.id} />
                          <SubmitButton size="sm" variant="secondary">{t("Roll back to this version")}</SubmitButton>
                        </ActionForm>
                      </div>
                    )}
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
