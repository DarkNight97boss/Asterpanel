import { desc, eq } from "drizzle-orm";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { Card, CardHeader, EmptyState, Input, StatusBadge, Table, Td } from "@/components/ui";
import { getDb, schema } from "@/db";
import { getLocale, getT } from "@/i18n";
import { formatDateTime } from "@/lib/format";
import { requireWorkload } from "@/platform/access";
import { backupAction, createBackup } from "../../../platform-actions";

const KIND: Record<string, string> = { manual: "Manual", scheduled: "Automatic", system: "System" };

export default async function Backups({ params }: { params: Promise<{ id: string }> }) {
  const { workload: w } = await requireWorkload((await params).id);
  const db = await getDb();
  const [t, locale, backups] = await Promise.all([getT(), getLocale(), db.select().from(schema.backups).where(eq(schema.backups.workloadId, w.id)).orderBy(desc(schema.backups.createdAt))]);
  const size = (b: number) => (b > 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(b / 1e6))} MB`);

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader title={t("Create a backup")} description={t("Files and database, stored on the server. Restoring always saves the current state first.")} />
        <div className="p-5">
          <ActionForm action={createBackup} className="flex max-w-xl flex-wrap items-start gap-3">
            <input type="hidden" name="id" value={w.id} />
            <Input name="note" placeholder={t("Note (optional), e.g. before plugin update")} maxLength={200} className="flex-1" />
            <SubmitButton disabled={w.status !== "running"}>{t("Back up now")}</SubmitButton>
          </ActionForm>
        </div>
      </Card>
      <Card>
        {backups.length ? (
          <Table head={[t("Created"), t("Type"), t("Note"), t("Size"), t("Off-site copy"), t("Status"), ""]}>
            {backups.map((b) => (
              <tr key={b.id}>
                <Td>{formatDateTime(b.createdAt, locale)}</Td>
                <Td>{t(KIND[b.kind])}</Td>
                <Td className="text-muted">{t(b.note) || "—"}</Td>
                <Td>{b.sizeBytes ? size(b.sizeBytes) : "—"}</Td>
                <Td className="text-body">{b.offsite === "uploaded" ? `✓ ${t("Stored off-site")}` : b.offsite === "pending" && b.status === "creating" ? "…" : b.offsite === "failed" ? <span className="text-danger" title={b.offsiteError}>{t("Upload failed")}</span> : <span className="text-muted">—</span>}</Td>
                <Td><StatusBadge status={b.status} label={t(b.status)} /></Td>
                <Td className="text-right">
                  {b.status === "ready" && (
                    <span className="inline-flex gap-1">
                      {(["restore", "delete"] as const).map((action) => (
                        <ActionForm key={action} action={backupAction} className="">
                          <input type="hidden" name="id" value={w.id} />
                          <input type="hidden" name="backupId" value={b.id} />
                          <input type="hidden" name="action" value={action} />
                          <SubmitButton size="sm" variant="ghost" confirm={action === "restore" ? t("Restore this backup? The current state is saved first.") : t("Delete this backup?")}>
                            {t(action === "restore" ? "Restore" : "Delete")}
                          </SubmitButton>
                        </ActionForm>
                      ))}
                    </span>
                  )}
                </Td>
              </tr>
            ))}
          </Table>
        ) : (
          <EmptyState title={t("No backups yet")} />
        )}
      </Card>
    </div>
  );
}
