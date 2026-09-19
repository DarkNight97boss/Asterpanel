import Link from "next/link";
import { Card, EmptyState, PageHeader } from "@/components/ui";
import { getLocale, getT } from "@/i18n";
import { requireAccount } from "@/lib/account";
import { accountAlerts } from "@/lib/alerts";
import { formatDateTime } from "@/lib/format";

const ICON = { ticket: "✉", invoice: "▦", workload: "!", job: "⊗" } as const;

export default async function Notifications() {
  const { account } = await requireAccount("support");
  const [t, locale, alerts] = await Promise.all([getT(), getLocale(), accountAlerts(account.id, account.role, undefined, account.only)]);
  return (
    <>
      <PageHeader title={t("Notifications")} description={t("Things that need your attention. They disappear on their own once handled.")} />
      <Card>
        {alerts.length ? (
          <ul className="divide-y divide-border">
            {alerts.map((a, i) => (
              <li key={i}>
                <Link href={a.href} className="flex items-center gap-4 px-6 py-4 hover:bg-subtle">
                  <span aria-hidden className={`grid size-9 shrink-0 place-items-center rounded-full text-sm ${a.kind === "ticket" ? "bg-success/10 text-success" : "bg-danger/10 text-danger"}`}>{ICON[a.kind]}</span>
                  <span className="min-w-0 flex-1 truncate text-fg">{t(a.text, a.vars)}</span>
                  <span className="shrink-0 text-xs text-muted">{formatDateTime(a.at, locale)}</span>
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState title={t("You are all caught up")} description={t("Nothing needs your attention right now.")} />
        )}
      </Card>
    </>
  );
}
