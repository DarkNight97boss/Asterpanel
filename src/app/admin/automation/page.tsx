import { desc } from "drizzle-orm";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { Card, CardHeader, EmptyState, PageHeader, Table, Td } from "@/components/ui";
import { getDb, schema } from "@/db";
import { getLocale, getT } from "@/i18n";
import { displayName } from "@/lib/auth";
import { formatDateTime } from "@/lib/format";
import { baseUrl } from "@/lib/url";
import { runAutomationNow } from "../actions";

export default async function Automation() {
  const db = await getDb();
  const [t, locale, origin, log] = await Promise.all([
    getT(),
    getLocale(),
    baseUrl(),
    db.query.auditLog.findMany({ with: { actor: { columns: { firstName: true, lastName: true, email: true } } }, orderBy: desc(schema.auditLog.createdAt), limit: 100 }),
  ]);

  return (
    <>
      <PageHeader title={t("Automation")} description={t("Renewal invoices, overdue suspensions and terminations.")} />
      <Card className="mb-6">
        <CardHeader title={t("Billing run")} description={t("Schedule this once a day (hourly is fine, the run is idempotent).")} />
        <div className="space-y-4 p-5">
          <pre className="overflow-x-auto rounded-theme border border-border bg-subtle p-3 font-mono text-xs">{`curl -fsS -X POST -H "Authorization: Bearer $CRON_SECRET" ${origin}/api/cron`}</pre>
          <ActionForm action={runAutomationNow}>
            <SubmitButton variant="secondary">{t("Run now")}</SubmitButton>
          </ActionForm>
        </div>
      </Card>
      <Card>
        <CardHeader title={t("Activity log")} />
        {log.length ? (
          <Table head={[t("Date"), t("Actor"), t("Action"), t("Details")]}>
            {log.map((e) => (
              <tr key={e.id}>
                <Td className="whitespace-nowrap text-muted">{formatDateTime(e.createdAt, locale)}</Td>
                <Td>{e.actor ? displayName(e.actor) : t("System")}</Td>
                <Td className="font-mono text-xs">{e.action}</Td>
                <Td className="max-w-md truncate font-mono text-xs text-muted">{Object.keys(e.meta).length ? JSON.stringify(e.meta) : e.entityId}</Td>
              </tr>
            ))}
          </Table>
        ) : (
          <EmptyState title={t("Nothing logged yet")} />
        )}
      </Card>
    </>
  );
}
