import { ActionForm, SubmitButton } from "@/components/action-form";
import { AutoRefresh } from "@/components/auto-refresh";
import { Alert, Card, CardHeader, EmptyState, PageHeader } from "@/components/ui";
import { getLocale, getT } from "@/i18n";
import { formatDateTime } from "@/lib/format";
import { requireWorkload } from "@/platform/access";
import { activeJobs, latestScan } from "@/platform/engine";
import { runTool } from "../../../platform-actions";

export default async function Security({ params }: { params: Promise<{ id: string }> }) {
  const { workload: w } = await requireWorkload((await params).id);
  const [t, locale, last, jobs] = await Promise.all([getT(), getLocale(), latestScan(w.id), activeJobs(w.id)]);
  const busy = jobs.some((j) => j.type === "workload.tool");
  const groups: [string, string, string[]][] = last
    ? [
        ["WordPress files that differ from the official release", "Replace them by reinstalling WordPress from Plugins and themes → Update, or restore a backup from before the change.", last.scan.core],
        ["Plugin files that differ from the official release", "Reinstall the plugin. Premium plugins that are not on wordpress.org cannot be checked and are not listed.", last.scan.plugins],
        ["PHP files inside uploads", "Uploads should hold images and documents only. Unless a plugin of yours puts them there on purpose, delete them.", last.scan.uploadsPhp],
        ["Files with code that hides what it does", "Patterns typical of backdoors. Some legitimate plugins use them too: look before deleting.", last.scan.suspicious],
      ]
    : [];

  return (
    <>
      <AutoRefresh active={busy} />
      <PageHeader
        title={t("Security scan")}
        description={t("Every week, and whenever you ask: WordPress and plugin files are compared with the official releases, and the site is searched for planted code. Nothing is changed.")}
        action={<ActionForm action={runTool} className=""><input type="hidden" name="id" value={w.id} /><input type="hidden" name="tool" value="wp.scan" /><SubmitButton disabled={busy || w.status !== "running"}>{busy ? t("Working…") : t("Scan now")}</SubmitButton></ActionForm>}
      />
      {!last ? (
        <Card><EmptyState title={t("Not scanned yet")} /></Card>
      ) : (
        <div className="space-y-6">
          {last.findings === 0 ? <Alert tone="success">{t("Nothing suspicious found on {date}.", { date: formatDateTime(last.at, locale) })}</Alert> : <Alert tone="danger">{t("{n} findings on {date}. Take a backup before cleaning up, and change the WordPress passwords afterwards.", { n: last.findings, date: formatDateTime(last.at, locale) })}</Alert>}
          {last.scan.truncated && <Alert tone="warning">{t("Only the first 100 entries of each list are shown.")}</Alert>}
          {groups.filter(([, , list]) => list.length).map(([title, advice, list]) => (
            <Card key={title}>
              <CardHeader title={`${t(title)} (${list.length})`} description={t(advice)} />
              <ul className="max-h-80 divide-y divide-border overflow-auto border-t border-border font-mono text-xs">
                {list.map((f) => <li key={f} className="px-5 py-2 break-all">{f}</li>)}
              </ul>
            </Card>
          ))}
        </div>
      )}
    </>
  );
}
