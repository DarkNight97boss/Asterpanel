import { ActionForm, SubmitButton } from "@/components/action-form";
import { Alert, Card, Checkbox, Field, PageHeader, Select } from "@/components/ui";
import { getT } from "@/i18n";
import { requireWorkload } from "@/platform/access";
import { CDN_MAX_AGES } from "@/platform/engine";
import { runTool, saveCdnSettings } from "../../../platform-actions";

const AGE_LABEL: Record<number, string> = { 1: "1 day", 7: "7 days", 30: "30 days", 365: "1 year" };

export default async function Cdn({ params }: { params: Promise<{ id: string }> }) {
  const { workload: w } = await requireWorkload((await params).id);
  const t = await getT();
  return (
    <>
      <PageHeader
        title="CDN"
        description={t("Images, CSS, JavaScript and fonts are served from the edge cache, compressed, with long browser caching.")}
        action={
          <ActionForm action={runTool} className="">
            <input type="hidden" name="id" value={w.id} />
            <input type="hidden" name="tool" value="cache.purge" />
            <SubmitButton disabled={w.status !== "running"}>{t("Clear cache")}</SubmitButton>
          </ActionForm>
        }
      />
      <div className="max-w-3xl space-y-6">
        <Alert tone="info">{t("Assets are accelerated at the edge of the server your site runs on ({region}). It is not a global network: visitors far from that region still travel to it.", { region: w.node.region || "—" })}</Alert>
        <Card className="p-6">
          <ActionForm action={saveCdnSettings}>
            <input type="hidden" name="id" value={w.id} />
            <Checkbox name="enabled" defaultChecked={!!w.config.cdnEnabled} label={t("Accelerate static assets")} />
            <Field label={t("Browser cache lifetime")} hint={t("WordPress adds a version to asset URLs, so updates still show up immediately.")} className="max-w-xs">
              <Select name="maxAge" defaultValue={String(w.config.cdnMaxAgeDays ?? 30)}>
                {CDN_MAX_AGES.map((d) => <option key={d} value={d}>{t(AGE_LABEL[d])}</option>)}
              </Select>
            </Field>
            <p className="text-xs text-muted">{t("Tip: the X-Aster-CDN response header says HIT or MISS for every asset.")}</p>
            <SubmitButton>{t("Save")}</SubmitButton>
          </ActionForm>
        </Card>
      </div>
    </>
  );
}
