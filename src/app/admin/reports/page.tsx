import { Card, CardHeader, PageHeader } from "@/components/ui";
import { getLocale, getT } from "@/i18n";
import { requireArea } from "@/lib/auth";
import { formatMoney } from "@/lib/format";
import { revenueReport } from "@/lib/reports";
import { getSettings } from "@/lib/settings";

export const metadata = { title: "Reports" };

export default async function Reports() {
  await requireArea("billing");
  const [t, locale, billing, r] = await Promise.all([getT(), getLocale(), getSettings("billing"), revenueReport()]);
  const money = (c: number) => formatMoney(c, billing.currency, locale);
  const peak = Math.max(1, ...r.months.map((m) => m.collected));
  const stats: [string, string, string?][] = [
    [t("Monthly recurring revenue"), money(r.mrr), t("{amount} a year", { amount: money(r.arr) })],
    [t("Paying customers"), String(r.customers), t("{n} active services", { n: r.activeServices })],
    [t("Average per customer"), money(r.arpa), t("per month")],
    [t("Churn, last 30 days"), `${(r.churnRate * 100).toFixed(1)}%`, `−${money(r.churnedMrr)} · +${money(r.newMrr)} ${t("new")}`],
  ];

  return (
    <>
      <PageHeader title={t("Reports")} description={t("Recurring revenue from active services (net of tax), and the cash collected each month.")} />
      <div className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {stats.map(([label, value, hint]) => (
          <Card key={label} className="p-5">
            <p className="text-sm text-muted">{label}</p>
            <p className="mt-1 text-3xl tracking-tight">{value}</p>
            {hint && <p className="mt-1 text-xs text-muted">{hint}</p>}
          </Card>
        ))}
      </div>
      <Card>
        <CardHeader title={t("Collected per month")} description={t("Payments received, credit excluded. Click a month to download its invoices as CSV.")} />
        <div className="flex h-56 items-end gap-2 px-5 pb-5">
          {r.months.map((m) => (
            <a key={m.key} href={`/api/admin/export?month=${m.key}`} className="group flex h-full min-w-0 flex-1 flex-col justify-end text-center" title={`${m.key}: ${money(m.collected)}`}>
              <span className="mb-1 truncate text-[10px] text-muted opacity-0 group-hover:opacity-100">{money(m.collected)}</span>
              <span className="w-full rounded-t-md bg-accent/80 group-hover:bg-accent" style={{ height: `${Math.max(2, (m.collected / peak) * 100)}%` }} />
              <span className="mt-1.5 text-[10px] text-muted">{m.key.slice(5)}/{m.key.slice(2, 4)}</span>
            </a>
          ))}
        </div>
      </Card>
    </>
  );
}
