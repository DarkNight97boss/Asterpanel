import { ActionForm, SubmitButton } from "@/components/action-form";
import { Card, Checkbox, Field, PageHeader, Select, Textarea } from "@/components/ui";
import { getT } from "@/i18n";
import { requireWorkload } from "@/platform/access";
import { CACHE_TTLS } from "@/platform/engine";
import { runTool, saveCaching } from "../../../platform-actions";

const TTL_LABEL: Record<number, string> = { 10: "10 minutes", 60: "1 hour", 240: "4 hours", 1440: "1 day", 10080: "7 days" };

export default async function Caching({ params }: { params: Promise<{ id: string }> }) {
  const { workload: w } = await requireWorkload((await params).id);
  const t = await getT();
  const c = w.config;
  return (
    <>
      <PageHeader
        title={t("Caching")}
        description={t("Full pages are served from the edge without touching PHP. Logged-in users, carts, checkout and the admin are never cached.")}
        action={
          <ActionForm action={runTool} className="">
            <input type="hidden" name="id" value={w.id} />
            <input type="hidden" name="tool" value="cache.purge" />
            <SubmitButton disabled={w.status !== "running"}>{t("Clear cache")}</SubmitButton>
          </ActionForm>
        }
      />
      <Card className="max-w-3xl p-6">
        <ActionForm action={saveCaching}>
          <input type="hidden" name="id" value={w.id} />
          <Checkbox name="enabled" defaultChecked={!!c.cacheEnabled} label={t("Enable edge page cache")} />
          <Field label={t("Cache lifetime")} hint={t("How long a page is served before it is fetched again. Clearing the cache always takes effect immediately.")} className="max-w-xs">
            <Select name="ttl" defaultValue={String(c.cacheTtlMinutes ?? 60)}>
              {CACHE_TTLS.map((m) => <option key={m} value={m}>{t(TTL_LABEL[m])}</option>)}
            </Select>
          </Field>
          <Field label={t("Never cache these paths")} hint={t("One path per line; everything starting with it is excluded, e.g. /members")}>
            <Textarea name="bypass" rows={5} defaultValue={(c.cacheBypass ?? []).join("\n")} className="font-mono" spellCheck={false} placeholder={"/members\n/api"} />
          </Field>
          <p className="text-xs text-muted">{t("Tip: the X-Aster-Cache response header says HIT, MISS or BYPASS for every request.")}</p>
          <SubmitButton>{t("Save")}</SubmitButton>
        </ActionForm>
      </Card>
    </>
  );
}
