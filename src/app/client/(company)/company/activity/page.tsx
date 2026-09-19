import { and, desc, eq, inArray, or } from "drizzle-orm";
import { Card, EmptyState, PageHeader, Table, Td } from "@/components/ui";
import { getDb, schema } from "@/db";
import { getLocale, getT } from "@/i18n";
import { requireAccount } from "@/lib/account";
import { displayName, formatDateTime } from "@/lib/format";

export const metadata = { title: "User activity" };

const ACTION: Record<string, string> = {
  "company.created": "Company created",
  "company.details_changed": "Billing details changed",
  "team.invited": "User invited",
  "team.joined": "User joined",
  "team.role_changed": "Role changed",
  "team.removed": "User removed",
  "team.left": "User left",
  "team.sites_changed": "Access changed",
  "team.ownership_transferred": "Ownership transferred",
  "workload.create": "Create service",
  "workload.update": "Change settings",
  "workload.start": "Start",
  "workload.stop": "Stop",
  "workload.restart": "Restart",
  "workload.delete": "Delete service",
  "backup.restore": "Restore backup",
  "staging.create": "Create staging",
  "staging.push": "Push staging to live",
  "domain.add": "Add domain",
  "domain.remove": "Remove domain",
  "db.query": "Database query",
  "sftp.enabled": "SFTP enabled",
  "sftp.disabled": "SFTP disabled",
  "sftp.key_added": "SSH key added",
  "sftp.key_removed": "SSH key removed",
};
/** Families with a variable tail: `tool.wp.update`, `files.write`. */
const FAMILY: Record<string, string> = { tool: "Run tool", files: "File manager" };
const label = (action: string) => ACTION[action] ?? FAMILY[action.split(".")[0]] ?? action;

export default async function CompanyActivity() {
  const { account } = await requireAccount("manage");
  const db = await getDb();
  const workloads = await db.select({ id: schema.workloads.id, name: schema.workloads.name }).from(schema.workloads).where(eq(schema.workloads.companyId, account.id));
  const names = new Map(workloads.map((w) => [w.id, w.name]));
  const [t, locale, rows, users] = await Promise.all([
    getT(),
    getLocale(),
    db
      .select()
      .from(schema.auditLog)
      .where(or(and(eq(schema.auditLog.entity, "company"), eq(schema.auditLog.entityId, account.id)), ...(workloads.length ? [and(eq(schema.auditLog.entity, "workload"), inArray(schema.auditLog.entityId, workloads.map((w) => w.id)))] : [])))
      .orderBy(desc(schema.auditLog.createdAt))
      .limit(200),
    db.select({ id: schema.users.id, firstName: schema.users.firstName, lastName: schema.users.lastName, email: schema.users.email }).from(schema.users),
  ]);
  const who = new Map(users.map((u) => [u.id, displayName(u)]));

  return (
    <>
      <PageHeader title={t("User activity")} description={t("What the users of {account} did, newest first.", { account: account.name })} />
      <Card>
        {rows.length ? (
          <Table head={[t("Action"), t("Service"), t("By"), t("Date"), "IP"]}>
            {rows.map((r) => (
              <tr key={r.id}>
                <Td>{t(label(r.action))}{!(r.action in ACTION) && <span className="ml-2 text-xs text-muted">{r.action.split(".").slice(1).join(".")}</span>}{typeof (r.meta.email ?? r.meta.hostname) === "string" && <span className="ml-2 text-muted">{String(r.meta.email ?? r.meta.hostname)}</span>}</Td>
                <Td className="text-body">{names.get(r.entityId) ?? "—"}</Td>
                <Td className="text-body">{(r.actorId && who.get(r.actorId)) || t("System")}</Td>
                <Td className="text-body">{formatDateTime(r.createdAt, locale)}</Td>
                <Td className="text-muted">{r.ip || "—"}</Td>
              </tr>
            ))}
          </Table>
        ) : (
          <EmptyState title={t("Nothing here yet")} />
        )}
      </Card>
    </>
  );
}
