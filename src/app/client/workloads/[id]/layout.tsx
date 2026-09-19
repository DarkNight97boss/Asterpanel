import Link from "next/link";
import { and, eq, ne } from "drizzle-orm";
import { AutoRefresh } from "@/components/auto-refresh";
import { NavLink } from "@/components/nav-link";
import { ShellSlot } from "@/components/portal";
import { Alert } from "@/components/ui";
import { getDb, schema } from "@/db";
import { getT } from "@/i18n";
import { requireWorkload } from "@/platform/access";
import { activeJobs } from "@/platform/engine";
import { WORKLOAD_LABEL } from "@/platform/ui";

const JOB_LABEL: Record<string, string> = {
  "workload.create": "Creating…",
  "workload.update": "Applying changes…",
  "workload.start": "Starting…",
  "workload.stop": "Stopping…",
  "workload.restart": "Restarting…",
  "workload.delete": "Deleting…",
  "workload.clone": "Copying environment…",
  "workload.deploy": "Deploying…",
  "workload.tool": "Running tool…",
  "workload.migrate": "Migrating the site…",
  "workload.logs": "Fetching logs…",
  "backup.create": "Creating backup…",
  "backup.restore": "Restoring backup…",
  "backup.delete": "Deleting backup…",
};

const DOT: Record<string, string> = { running: "bg-success", creating: "bg-warning", deleting: "bg-warning", error: "bg-danger", suspended: "bg-danger" };

export default async function WorkloadLayout({ children, params }: { children: React.ReactNode; params: Promise<{ id: string }> }) {
  const { workload: w } = await requireWorkload((await params).id);
  const db = await getDb();
  const liveId = w.parentId ?? w.id;
  const [t, jobs, siblings] = await Promise.all([
    getT(),
    activeJobs(w.id),
    // The other environment of the same site, for the switcher in the top bar.
    w.type === "wordpress"
      ? db.select({ id: schema.workloads.id, environment: schema.workloads.environment }).from(schema.workloads).where(and(ne(schema.workloads.status, "deleted"), ne(schema.workloads.id, w.id), w.parentId ? eq(schema.workloads.id, liveId) : eq(schema.workloads.parentId, liveId)))
      : [],
  ]);
  const label = WORKLOAD_LABEL[w.type];
  const base = `/client/workloads/${w.id}`;

  const sections = [
    { href: base, label: t("Info"), exact: true },
    ...(w.type !== "database" ? [{ href: `${base}/domains`, label: t("Domains") }] : []),
    ...(w.type === "app" || w.type === "static" ? [{ href: `${base}/deployments`, label: t("Deployments") }] : []),
    ...(w.type !== "static" ? [{ href: `${base}/backups`, label: t("Backups") }] : []),
    ...(w.type === "wordpress" ? [{ href: `${base}/tools`, label: t("Tools") }] : []),
    ...(w.type === "wordpress" && w.environment === "live" ? [{ href: `${base}/migrate`, label: t("Migration") }] : []),
    ...(w.type === "wordpress" ? [{ href: `${base}/caching`, label: t("Caching") }, { href: `${base}/files`, label: t("Files") }] : []),
    ...(w.type === "wordpress" ? [{ href: `${base}/sftp`, label: "SFTP" }] : []),
    ...(w.type === "wordpress" || (w.type === "database" && w.config.engine !== "redis") ? [{ href: `${base}/database`, label: t("Database") }] : []),
    ...(w.type !== "database" ? [{ href: `${base}/redirects`, label: t("Redirects") }] : []),
    ...(w.type === "wordpress" ? [{ href: `${base}/plugins`, label: t("Plugins and themes") }] : []),
    ...(w.type === "wordpress" ? [{ href: `${base}/security`, label: t("Security scan") }] : []),
    ...(w.type !== "database" ? [{ href: `${base}/ip-deny`, label: t("IP deny") }] : []),
    ...(w.type !== "database" ? [{ href: `${base}/bot-protection`, label: t("Bot protection") }] : []),
    ...(w.type === "wordpress" ? [{ href: `${base}/cdn`, label: "CDN" }] : []),
    { href: `${base}/analytics`, label: t("Analytics") },
    ...(w.type !== "database" ? [{ href: `${base}/apm`, label: "APM" }] : []),
    { href: `${base}/activity`, label: t("User activity") },
    { href: `${base}/logs`, label: t("Logs") },
    { href: `${base}/settings`, label: t("Settings") },
  ];

  return (
    <>
      <AutoRefresh active={jobs.length > 0} />

      <ShellSlot slot="crumbs">
        <span className="text-white/40">/</span>
        <Link href={label.path} className="hidden text-white/85 hover:text-white sm:inline">{t(label.many)}</Link>
        <span className="hidden text-white/40 sm:inline">/</span>
        <span className="truncate font-medium">{w.name.replace(/ \(staging\)$/, "")}</span>
        {w.type === "wordpress" && (
          <>
            <span className="text-white/40">/</span>
            <span className="inline-flex items-center gap-2 whitespace-nowrap">
              <span className={`size-2 rounded-full ${DOT[w.status] ?? "bg-white/50"}`} />
              {w.environment === "live" ? "Live" : "Staging"}
            </span>
            {siblings.map((s) => (
              <Link key={s.id} href={`/client/workloads/${s.id}`} className="rounded-md border border-white/25 px-2 py-0.5 text-xs text-white/80 hover:bg-white/10 hover:text-white">
                → {s.environment === "live" ? "Live" : "Staging"}
              </Link>
            ))}
          </>
        )}
      </ShellSlot>

      <ShellSlot slot="context-nav">
        {sections.map((s) => (
          <NavLink key={s.href} href={s.href} exact={s.exact}>{s.label}</NavLink>
        ))}
        <Link href={label.path} className="mt-4 hidden h-10 items-center px-4 text-sm text-muted hover:text-fg lg:flex">← {t(label.many)}</Link>
      </ShellSlot>

      {jobs.length > 0 && (
        <div className="mb-5">
          <Alert tone="info">
            <span className="mr-2 inline-block size-3 animate-spin rounded-full border-2 border-current border-t-transparent align-[-2px]" />
            {t(JOB_LABEL[jobs[0].type] ?? "Working…")} {jobs.length > 1 && t("(+{n} queued)", { n: jobs.length - 1 })}
          </Alert>
        </div>
      )}
      {w.status === "error" && <div className="mb-5"><Alert tone="danger">{w.statusMessage || t("Something went wrong.")}</Alert></div>}
      {w.status === "suspended" && <div className="mb-5"><Alert tone="danger">{t("This service is suspended.")} {t(w.statusMessage)}</Alert></div>}
      {children}
    </>
  );
}
