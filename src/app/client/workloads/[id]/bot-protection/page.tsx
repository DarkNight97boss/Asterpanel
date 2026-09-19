import { ActionForm, SubmitButton } from "@/components/action-form";
import { Card, Checkbox, Field, Input, PageHeader } from "@/components/ui";
import { getT } from "@/i18n";
import { requireWorkload } from "@/platform/access";
import { saveBotProtection } from "../../../platform-actions";

export default async function BotProtection({ params }: { params: Promise<{ id: string }> }) {
  const { workload: w } = await requireWorkload((await params).id);
  const t = await getT();
  const c = w.config;
  const Option = ({ name, checked, title, text }: { name: string; checked: boolean; title: string; text: string }) => (
    <div className="rounded-theme border border-border p-4">
      <Checkbox name={name} defaultChecked={checked} label={<span className="font-medium text-fg">{title}</span>} />
      <p className="mt-1.5 pl-6 text-sm text-muted">{text}</p>
    </div>
  );
  return (
    <>
      <PageHeader title={t("Bot protection")} description={t("Unwanted traffic is stopped at the edge, before it costs your site any CPU.")} />
      <Card className="max-w-3xl p-6">
        <ActionForm action={saveBotProtection}>
          <input type="hidden" name="id" value={w.id} />
          {Option({ name: "blockBad", checked: !!c.botsBlockBad, title: t("Block bad bots"), text: t("SEO scrapers, vulnerability scanners and scripted clients (Semrush, Ahrefs, MJ12, sqlmap, curl…). Search engines are never blocked.") })}
          {Option({ name: "blockAi", checked: !!c.botsBlockAi, title: t("Block AI crawlers"), text: t("Crawlers that collect content to train or feed AI models (GPTBot, ClaudeBot, CCBot, Google-Extended, PerplexityBot…).") })}
          {w.type === "wordpress" && Option({ name: "protectLogin", checked: !!c.botsProtectLogin, title: t("Protect the login page"), text: t("wp-login.php and xmlrpc.php accept at most 10 requests a minute from one IP address: brute-force attacks stall, people never notice.") })}
          <Field label={t("Rate limit per IP address")} hint={t("Requests per minute allowed from one visitor. 0 = no limit. 600 is a safe start for most sites.")} className="max-w-xs">
            <Input name="rate" type="number" min={0} max={100000} defaultValue={c.botsRatePerMinute ?? 0} />
          </Field>
          <SubmitButton>{t("Save")}</SubmitButton>
        </ActionForm>
      </Card>
    </>
  );
}
