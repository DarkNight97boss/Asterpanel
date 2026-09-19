import { desc } from "drizzle-orm";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { ButtonLink, Card, CardHeader, EmptyState, Field, Input, PageHeader, Select, StatusBadge, Textarea } from "@/components/ui";
import { getDb, schema } from "@/db";
import { getLocale, getT } from "@/i18n";
import { requireArea } from "@/lib/auth";
import { formatDateTime } from "@/lib/format";
import { openIncident, updateIncident } from "../extras-actions";

export const metadata = { title: "Status page" };

const STATUSES = ["investigating", "identified", "monitoring", "resolved"] as const;

export default async function AdminStatus() {
  await requireArea("platform");
  const [t, locale, rows] = await Promise.all([getT(), getLocale(), (await getDb()).select().from(schema.incidents).orderBy(desc(schema.incidents.startedAt)).limit(30)]);
  return (
    <>
      <PageHeader title={t("Status page")} description={t("Tell customers about incidents and planned maintenance before they have to ask.")} action={<ButtonLink href="/status" variant="secondary">{t("View public page")} ↗</ButtonLink>} />
      <div className="space-y-6">
        <Card>
          <CardHeader title={t("New incident or maintenance")} />
          <div className="p-5">
            <ActionForm action={openIncident}>
              <div className="grid gap-4 sm:grid-cols-[1fr_14rem]">
                <Field label={t("Title")}><Input name="title" required maxLength={140} placeholder={t("Slow responses in eu-central")} /></Field>
                <Field label={t("Impact")}><Select name="impact" defaultValue="minor"><option value="minor">{t("Minor")}</option><option value="major">{t("Major")}</option><option value="maintenance">{t("Maintenance")}</option></Select></Field>
              </div>
              <Field label={t("First message")}><Textarea name="message" rows={3} required /></Field>
              <SubmitButton>{t("Publish")}</SubmitButton>
            </ActionForm>
          </div>
        </Card>
        {rows.length ? rows.map((i) => (
          <Card key={i.id}>
            <CardHeader title={<span className="flex flex-wrap items-center gap-3">{i.title} <StatusBadge status={i.status === "resolved" ? "active" : i.impact === "major" ? "error" : "creating"} label={t(i.status)} /></span>} description={formatDateTime(i.startedAt, locale)} />
            <ul className="space-y-2 px-5 pb-4 text-sm">
              {i.updates.map((u, n) => <li key={n}><span className="text-muted">{formatDateTime(new Date(u.at), locale)} · {t(u.status)} — </span>{u.message}</li>)}
            </ul>
            {i.status !== "resolved" && (
              <div className="border-t border-border p-5">
                <ActionForm action={updateIncident}>
                  <input type="hidden" name="id" value={i.id} />
                  <div className="grid gap-4 sm:grid-cols-[14rem_1fr]">
                    <Field label={t("Status")}><Select name="status" defaultValue={i.status}>{STATUSES.map((s) => <option key={s} value={s}>{t(s)}</option>)}</Select></Field>
                    <Field label={t("Update")}><Input name="message" required maxLength={2000} /></Field>
                  </div>
                  <SubmitButton variant="secondary">{t("Publish")}</SubmitButton>
                </ActionForm>
              </div>
            )}
          </Card>
        )) : <Card><EmptyState title={t("No incidents")} /></Card>}
      </div>
    </>
  );
}
