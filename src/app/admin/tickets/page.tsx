import Link from "next/link";
import { desc, ne } from "drizzle-orm";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { Badge, Card, CardHeader, EmptyState, Field, Input, PageHeader, StatusBadge, STATUS_LABEL, Table, Td } from "@/components/ui";
import { getDb, schema } from "@/db";
import { getLocale, getT } from "@/i18n";
import { displayName, requireArea } from "@/lib/auth";
import { formatDateTime } from "@/lib/format";
import { getSettings } from "@/lib/settings";
import { slaState } from "@/lib/sla";
import { saveSla } from "../extras-actions";

export default async function Tickets({ searchParams }: { searchParams: Promise<{ all?: string; department?: string }> }) {
  const me = await requireArea("support");
  const sp = await searchParams;
  const all = !!sp.all;
  const department = ["support", "billing", "sales"].find((d) => d === sp.department);
  const db = await getDb();
  const [t, locale, support, found] = await Promise.all([
    getT(),
    getLocale(),
    getSettings("support"),
    db.query.tickets.findMany({
      where: all ? undefined : ne(schema.tickets.status, "closed"),
      with: { client: { columns: { passwordHash: false } } },
      orderBy: desc(schema.tickets.lastReplyAt),
      limit: 300,
    }),
  ]);
  const sla = { low: support.slaLow, medium: support.slaMedium, high: support.slaHigh };
  // Whoever has waited past the target comes first, then whoever is closest to it.
  const tickets = found
    .filter((tk) => !department || tk.department === department)
    .map((tk) => ({ ...tk, sla: slaState(tk, sla) }))
    .sort((a, b) => Number(b.sla.waiting) - Number(a.sla.waiting) || (a.sla.waiting ? a.sla.hoursLeft - b.sla.hoursLeft : b.lastReplyAt.getTime() - a.lastReplyAt.getTime()));
  const breached = tickets.filter((tk) => tk.sla.breached).length;

  return (
    <>
      <PageHeader
        title={t("Tickets")}
        action={<Link href={all ? "/admin/tickets" : "/admin/tickets?all=1"} className="text-sm text-link">{all ? t("Hide closed") : t("Show closed")}</Link>}
      />
      <div className="mb-4 flex flex-wrap items-center gap-2 text-sm">
        {[["", "All departments"], ["support", "Support"], ["billing", "Billing"], ["sales", "Sales"]].map(([d, label]) => (
          <Link key={d} href={`/admin/tickets?${new URLSearchParams({ ...(d ? { department: d } : {}), ...(all ? { all: "1" } : {}) })}`} className={`rounded-full border px-3 py-1 ${(department ?? "") === d ? "border-fg bg-subtle font-medium" : "border-border text-muted hover:text-fg"}`}>{t(label)}</Link>
        ))}
        {breached > 0 && <span className="ml-auto"><Badge tone="danger">{t("{n} past the response target", { n: breached })}</Badge></span>}
      </div>
      <Card>
        {tickets.length ? (
          <Table head={["#", t("Subject"), t("Client"), t("Department"), t("Last reply"), t("Answer by"), t("Status")]}>
            {tickets.map((tk) => (
              <tr key={tk.id}>
                <Td className="text-muted">{tk.number}</Td>
                <Td>
                  <Link href={`/admin/tickets/${tk.id}`} className="font-medium hover:text-link">{tk.subject}</Link>{" "}
                  {tk.priority === "high" && <Badge tone="danger">{t("High")}</Badge>}
                </Td>
                <Td>{displayName(tk.client)}</Td>
                <Td className="capitalize">{tk.department}</Td>
                <Td>{formatDateTime(tk.lastReplyAt, locale)}</Td>
                <Td>{!tk.sla.waiting ? <span className="text-muted">—</span> : tk.sla.breached ? <Badge tone="danger">{t("{n} h late", { n: Math.ceil(-tk.sla.hoursLeft) })}</Badge> : tk.sla.hoursLeft < 2 ? <Badge tone="warning">{t("{n} min left", { n: Math.max(1, Math.round(tk.sla.hoursLeft * 60)) })}</Badge> : <span className="text-body">{t("{n} h left", { n: Math.floor(tk.sla.hoursLeft) })}</span>}</Td>
                <Td><StatusBadge status={tk.status} label={t(STATUS_LABEL[tk.status])} /></Td>
              </tr>
            ))}
          </Table>
        ) : (
          <EmptyState title={t("No tickets")} description={t("Nothing is waiting for you.")} />
        )}
      </Card>
      {me.role === "admin" && (
        <Card className="mt-6">
          <CardHeader title={t("Response targets")} description={t("Hours within which a waiting customer should get an answer. Tickets past their target are listed first.")} />
          <div className="p-5">
            <ActionForm action={saveSla}>
              <div className="grid max-w-xl gap-4 sm:grid-cols-3">
                <Field label={t("High")}><Input name="slaHigh" type="number" min={1} max={720} defaultValue={support.slaHigh} /></Field>
                <Field label={t("Medium")}><Input name="slaMedium" type="number" min={1} max={720} defaultValue={support.slaMedium} /></Field>
                <Field label={t("Low")}><Input name="slaLow" type="number" min={1} max={720} defaultValue={support.slaLow} /></Field>
              </div>
              <SubmitButton variant="secondary">{t("Save")}</SubmitButton>
            </ActionForm>
          </div>
        </Card>
      )}
    </>
  );
}
