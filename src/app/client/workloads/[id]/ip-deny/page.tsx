import { ActionForm, SubmitButton } from "@/components/action-form";
import { Card, Field, PageHeader, Textarea } from "@/components/ui";
import { getT } from "@/i18n";
import { requireWorkload } from "@/platform/access";
import { saveDenyList } from "../../../platform-actions";

export default async function IpDeny({ params }: { params: Promise<{ id: string }> }) {
  const { workload: w } = await requireWorkload((await params).id);
  const t = await getT();
  return (
    <>
      <PageHeader title={t("IP deny")} description={t("Block abusive visitors, bots and scrapers before they reach your site.")} />
      <Card className="max-w-2xl p-6">
        <ActionForm action={saveDenyList}>
          <input type="hidden" name="id" value={w.id} />
          <Field label={t("Denied IP addresses")} hint={t("One per line. IPv4, IPv6 and CIDR ranges such as 203.0.113.0/24 are accepted.")}>
            <Textarea name="ips" rows={10} defaultValue={(w.config.denyIps ?? []).join("\n")} className="font-mono" spellCheck={false} placeholder={"198.51.100.24\n203.0.113.0/24"} />
          </Field>
          <SubmitButton>{t("Save")}</SubmitButton>
        </ActionForm>
      </Card>
    </>
  );
}
