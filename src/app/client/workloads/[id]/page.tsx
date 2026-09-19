import Link from "next/link";
import { and, desc, eq, ne } from "drizzle-orm";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { Badge, buttonClass, ButtonLink, Card, CardHeader, DataField, PageHeader, StatusBadge } from "@/components/ui";
import { getDb, schema } from "@/db";
import { getLocale, getT } from "@/i18n";
import { formatDateTime } from "@/lib/format";
import { requireWorkload } from "@/platform/access";
import { readSecrets } from "@/platform/engine";
import { power, staging, wpLogin } from "../../platform-actions";

const Secret = ({ value, reveal }: { value: string; reveal: string }) => (
  <details className="group inline">
    <summary className="cursor-pointer list-none text-link group-open:hidden">{reveal}</summary>
    <code className="font-mono text-xs break-all select-all">{value}</code>
  </details>
);

const TITLE = { wordpress: "Site information", app: "Application information", database: "Database information", static: "Site information" } as const;

export default async function Overview({ params }: { params: Promise<{ id: string }> }) {
  const { workload: w } = await requireWorkload((await params).id);
  const db = await getDb();
  const [t, locale, stagingEnvs, parent, lastDeploy] = await Promise.all([
    getT(),
    getLocale(),
    db.select().from(schema.workloads).where(and(eq(schema.workloads.parentId, w.id), ne(schema.workloads.status, "deleted"))),
    w.parentId ? db.query.workloads.findFirst({ where: eq(schema.workloads.id, w.parentId) }) : undefined,
    db.query.deployments.findFirst({ where: eq(schema.deployments.workloadId, w.id), orderBy: desc(schema.deployments.createdAt) }),
  ]);
  const lastBackup = await db.query.backups.findFirst({ where: and(eq(schema.backups.workloadId, w.id), eq(schema.backups.status, "ready")), orderBy: desc(schema.backups.createdAt) });
  const secrets = readSecrets(w);
  const primary = w.domains[0]?.hostname;
  const c = w.config;
  const busy = w.status === "creating" || w.status === "deleting";
  const reveal = t("Show");

  const dbUrl =
    w.type === "database" && w.runtime.internalHost
      ? c.engine === "redis"
        ? `redis://:${secrets.dbPassword}@${w.runtime.internalHost}:6379`
        : `${c.engine === "postgres" ? "postgres" : "mysql"}://${w.runtime.dbUser}:${secrets.dbPassword}@${w.runtime.internalHost}:${c.engine === "postgres" ? 5432 : 3306}/${w.runtime.dbName}`
      : null;

  const rows: [string, React.ReactNode][] = [
    ...(w.type === "wordpress"
      ? ([
          [t("Admin username"), c.adminUser ?? "admin"],
          [t("Admin password"), secrets.adminPassword ? <Secret key="p" value={secrets.adminPassword} reveal={reveal} /> : "—"],
          [t("PHP version"), c.phpVersion ?? "—"],
          [t("WordPress version"), w.runtime.version || "—"],
        ] as [string, React.ReactNode][])
      : []),
    ...(w.type === "database"
      ? ([
          [t("Engine"), `${c.engine} ${c.version ?? ""}`],
          [t("Internal host"), <code key="h" className="font-mono text-xs">{w.runtime.internalHost ?? "—"}</code>],
          [t("Database / user"), `${w.runtime.dbName ?? "—"} / ${w.runtime.dbUser ?? "—"}`],
          [t("Password"), secrets.dbPassword ? <Secret key="p" value={secrets.dbPassword} reveal={reveal} /> : "—"],
          [t("Connection URL"), dbUrl ? <Secret key="u" value={dbUrl} reveal={reveal} /> : "—"],
        ] as [string, React.ReactNode][])
      : []),
    ...(w.type === "app" || w.type === "static"
      ? ([
          [t("Repository"), <span key="r" className="break-all">{c.repoUrl}</span>],
          [t("Branch"), c.branch ?? "main"],
          [t("Last deployment"), lastDeploy ? <><Badge tone={lastDeploy.status === "live" ? "success" : lastDeploy.status === "failed" ? "danger" : "warning"}>{t(lastDeploy.status)}</Badge> <code className="font-mono text-xs">{lastDeploy.commitSha.slice(0, 7)}</code> {lastDeploy.commitMessage}</> : "—"],
        ] as [string, React.ReactNode][])
      : []),
    [t("Resources"), `${c.memoryMb ?? 512} MB RAM · ${c.cpus ?? 1} vCPU · ${c.diskGb ?? 10} GB`],
    [t("Disk used"), w.runtime.diskUsedMb != null ? `${w.runtime.diskUsedMb} MB` : "—"],
    [t("Location"), `${w.node.region || "—"}${w.node.publicIp ? ` · ${w.node.publicIp}` : ""}`],
    [t("Created"), formatDateTime(w.createdAt, locale)],
  ];

  const visit = primary && w.status === "running" && w.type !== "database";

  return (
    <>
      <PageHeader
        title={t(TITLE[w.type])}
        action={
          visit ? (
            <>
              {w.type === "wordpress" &&
                (w.status === "running" ? (
                  <form action={wpLogin} target="_blank"><input type="hidden" name="id" value={w.id} /><button className={buttonClass("secondary")} title={t("Signs you in without a password, with a link that works once")}>{t("WordPress admin")} ↗</button></form>
                ) : (
                  <a href={`https://${primary}/wp-admin/`} target="_blank" rel="noopener noreferrer" className={buttonClass("secondary")}>{t("WordPress admin")} ↗</a>
                ))}
              <a href={`https://${primary}`} target="_blank" rel="noopener noreferrer" className={buttonClass("primary")}>{t("Visit site")} ↗</a>
            </>
          ) : undefined
        }
      />
      <div className="grid items-start gap-6 xl:grid-cols-[1fr_21rem]">
        <div className="space-y-6">
          <Card className="p-6">
            <h2 className="mb-5 text-xl font-medium">{t("Details")}</h2>
            <div className="grid gap-x-6 gap-y-5 sm:grid-cols-2 lg:grid-cols-3">
              <DataField label={t("Name")}>{w.name}</DataField>
              <DataField label={t("Status")}><StatusBadge status={w.status} label={t(w.status)} /></DataField>
              {rows.map(([label, value]) => (
                <DataField key={label} label={label}>{value}</DataField>
              ))}
            </div>
          </Card>
        </div>

      <div className="space-y-6">
        {w.type !== "database" && (
          <Card className="p-6">
            <h2 className="mb-3 text-sm font-bold">{t("Domains")}</h2>
            <ul className="space-y-2 text-sm">
              {w.domains.map((d) => (
                <li key={d.id} className="flex items-center gap-2">
                  <span aria-hidden className="text-success">✓</span>
                  <span className="min-w-0 truncate">{d.hostname}</span>
                  {d.isPrimary && <Badge>{t("Primary")}</Badge>}
                </li>
              ))}
            </ul>
            <Link href={`/client/workloads/${w.id}/domains`} className="mt-4 inline-block text-sm text-link hover:underline">{t("Manage domains")} →</Link>
          </Card>
        )}
        {w.type !== "static" && (
          <Card className="p-6">
            <h2 className="mb-3 text-sm font-bold">{t("Backups")}</h2>
            <p className="text-sm text-body">{lastBackup ? t("Last backup: {date}", { date: formatDateTime(lastBackup.createdAt, locale) }) : t("No backups yet")}</p>
            <p className="mt-1 text-xs text-muted">{t("A backup is taken automatically every day and kept for 14 days.")}</p>
            <Link href={`/client/workloads/${w.id}/backups`} className="mt-4 inline-block text-sm text-link hover:underline">{t("Manage backups")} →</Link>
          </Card>
        )}
        <Card>
          <CardHeader title={t("Power")} />
          <div className="flex flex-wrap gap-2 p-5">
            {(w.status === "running" ? (["restart", "stop"] as const) : (["start"] as const)).map((action) => (
              <ActionForm key={action} action={power} className="">
                <input type="hidden" name="id" value={w.id} />
                <input type="hidden" name="action" value={action} />
                <SubmitButton variant="secondary" disabled={busy || w.status === "suspended"}>{t(action === "restart" ? "Restart" : action === "stop" ? "Stop" : "Start")}</SubmitButton>
              </ActionForm>
            ))}
          </div>
        </Card>

        {w.type === "wordpress" && (
          <Card>
            <CardHeader title={t("Staging")} description={w.environment === "live" ? t("A private copy of your site to test changes safely.") : t("Changes here do not affect the live site until you push them.")} />
            <div className="space-y-3 p-5">
              {w.environment === "live" ? (
                stagingEnvs.length ? (
                  <ButtonLink href={`/client/workloads/${stagingEnvs[0].id}`} variant="secondary" className="w-full">{t("Open staging environment")} →</ButtonLink>
                ) : (
                  <ActionForm action={staging}>
                    <input type="hidden" name="id" value={w.id} />
                    <input type="hidden" name="action" value="create" />
                    <SubmitButton className="w-full" disabled={w.status !== "running"}>{t("Create staging environment")}</SubmitButton>
                  </ActionForm>
                )
              ) : (
                <>
                  {parent && <Link href={`/client/workloads/${parent.id}`} className="block text-sm text-link">← {t("Live site")}: {parent.name}</Link>}
                  <ActionForm action={staging}>
                    <input type="hidden" name="id" value={w.id} />
                    <input type="hidden" name="action" value="push" />
                    <SubmitButton className="w-full" disabled={w.status !== "running"} confirm={t("Replace the live site with this staging copy? A backup of live is taken first.")}>{t("Push staging to live")}</SubmitButton>
                  </ActionForm>
                  <ActionForm action={staging}>
                    <input type="hidden" name="id" value={w.id} />
                    <input type="hidden" name="action" value="delete" />
                    <SubmitButton variant="ghost" className="w-full" confirm={t("Delete the staging environment?")}>{t("Delete staging")}</SubmitButton>
                  </ActionForm>
                </>
              )}
            </div>
          </Card>
        )}
      </div>
      </div>
    </>
  );
}
