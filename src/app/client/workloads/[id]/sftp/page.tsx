import { ActionForm, SubmitButton } from "@/components/action-form";
import { Alert, Card, DataField, PageHeader } from "@/components/ui";
import { getT } from "@/i18n";
import { requireWorkload } from "@/platform/access";
import { readSecrets, sftpUsername } from "@/platform/engine";
import { sftpAction } from "../../../platform-actions";

export default async function Sftp({ params }: { params: Promise<{ id: string }> }) {
  const { workload: w } = await requireWorkload((await params).id);
  const t = await getT();
  const on = !!w.config.sftpEnabled;
  const host = w.node.publicIp || w.domains[0]?.hostname || "—";
  const user = sftpUsername(w.slug);
  const password = readSecrets(w).sftpPassword ?? "";

  const Act = ({ action, label, variant, confirm }: { action: string; label: string; variant: "primary" | "secondary" | "ghost"; confirm?: string }) => (
    <ActionForm action={sftpAction} className="">
      <input type="hidden" name="id" value={w.id} />
      <input type="hidden" name="action" value={action} />
      <SubmitButton variant={variant} confirm={confirm} disabled={w.status !== "running"}>{label}</SubmitButton>
    </ActionForm>
  );

  return (
    <>
      <PageHeader title="SFTP" description={t("Secure file access to your site, locked to its own files.")} action={on ? Act({ action: "disable", label: t("Disable"), variant: "secondary" }) : Act({ action: "enable", label: t("Enable SFTP"), variant: "primary" })} />
      {on ? (
        <div className="space-y-6">
          <Card className="p-6">
            <h2 className="mb-5 text-xl font-medium">{t("Connection details")}</h2>
            <div className="grid gap-x-6 gap-y-5 sm:grid-cols-2 lg:grid-cols-4">
              <DataField label={t("Host")}><span className="select-all">{host}</span></DataField>
              <DataField label={t("Port")}><span className="select-all">{w.config.sftpPort}</span></DataField>
              <DataField label={t("Username")}><span className="select-all">{user}</span></DataField>
              <DataField label={t("Password")}>
                <details className="group"><summary className="cursor-pointer list-none text-link group-open:hidden">{t("Show")}</summary><code className="font-mono text-xs select-all">{password}</code></details>
              </DataField>
              <DataField label={t("Terminal command")} className="sm:col-span-2 lg:col-span-4"><code className="font-mono text-xs select-all">sftp -P {w.config.sftpPort} {user}@{host}</code></DataField>
            </div>
            <p className="mt-5 text-sm text-muted">{t("Your files are in the “site” folder. WordPress lives in site/, uploads in site/wp-content/uploads.")}</p>
          </Card>
          <Card className="flex flex-wrap items-center justify-between gap-4 p-6">
            <div>
              <h2 className="text-xl font-medium">{t("Generate a new password")}</h2>
              <p className="mt-1 text-sm text-muted">{t("The current password stops working immediately.")}</p>
            </div>
            {Act({ action: "rotate", label: t("Generate new password"), variant: "secondary", confirm: t("Generate a new SFTP password?") })}
          </Card>
        </div>
      ) : (
        <Alert tone="info">{t("SFTP is off. Enable it only while you need it: fewer open doors, fewer problems.")}</Alert>
      )}
    </>
  );
}
