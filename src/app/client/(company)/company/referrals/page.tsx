import { notFound } from "next/navigation";
import { Card, CardHeader, DataField, PageHeader } from "@/components/ui";
import { getLocale, getT } from "@/i18n";
import { requireAccount } from "@/lib/account";
import { formatMoney } from "@/lib/format";
import { referralCodeOf, referralStats } from "@/lib/referrals";
import { getSettings } from "@/lib/settings";
import { baseUrl } from "@/lib/url";

export const metadata = { title: "Referrals" };

export default async function Referrals() {
  const { account } = await requireAccount("billing");
  const billing = await getSettings("billing");
  if (!billing.referralPercent) notFound();
  const [t, locale, origin, code, stats] = await Promise.all([getT(), getLocale(), baseUrl(), referralCodeOf(account.id), referralStats(account.id)]);
  return (
    <>
      <PageHeader title={t("Referrals")} description={t("Bring a customer and get {percent}% of what they pay for {months} months, as credit on your next invoices.", { percent: billing.referralPercent, months: billing.referralMonths })} />
      <div className="space-y-6">
        <Card>
          <CardHeader title={t("Your link")} description={t("Whoever signs up through it is linked to {account}.", { account: account.name })} />
          <div className="p-5 pt-0"><code className="block overflow-x-auto rounded-theme border border-border bg-subtle p-3 font-mono text-sm select-all">{origin}/register?ref={code}</code></div>
        </Card>
        <Card>
          <div className="grid gap-5 p-5 sm:grid-cols-2">
            <DataField label={t("Customers referred")}>{stats.referred}</DataField>
            <DataField label={t("Credit earned")}>{formatMoney(stats.earned, billing.currency, locale)}</DataField>
          </div>
        </Card>
      </div>
    </>
  );
}
