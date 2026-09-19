import { PanelShell } from "@/components/panel-shell";
import { getT } from "@/i18n";
import { getAccount, roleCan } from "@/lib/account";
import { endImpersonation } from "@/app/client/(company)/team/actions";
import { accountAlerts } from "@/lib/alerts";
import { getImpersonator } from "@/lib/auth";
import { ensureInstalled } from "@/lib/install";
import { WORKLOAD_LABEL } from "@/platform/ui";

export const metadata = { title: "Dashboard" };

export default async function ClientLayout({ children }: { children: React.ReactNode }) {
  await ensureInstalled();
  const [{ user, account, accounts }, t] = await Promise.all([getAccount(), getT()]);
  const acting = await getImpersonator();
  const alerts = await accountAlerts(account.id, account.role, undefined, account.only);
  const can = (p: Parameters<typeof roleCan>[1]) => roleCan(account.role, p);
  return (
    <PanelShell
      home="/client"
      user={user}
      account={account}
      accounts={accounts}
      alerts={alerts.length}
      nav={[
        { items: [{ href: "/client", label: t("Dashboard"), icon: "◧", exact: true }] },
        ...(can("hosting") ? [{ title: t("Hosting"), items: [...Object.values(WORKLOAD_LABEL).map((l) => ({ href: l.path, label: t(l.many), icon: l.icon })), ...(account.only ? [] : [{ href: "/client/domains", label: t("Domains"), icon: "◍" }, { href: "/client/dns", label: t("DNS management"), icon: "⇄" }])] }] : []),
        {
          title: t("Company"),
          items: [
            { href: can("billing") ? "/client/services" : "/client/team", label: t("Company settings"), icon: "⚙" },
            { href: "/client/tickets", label: t("Support"), icon: "✉" },
            { href: "/client/profile", label: t("Profile"), icon: "☺" },
          ],
        },
      ]}
    >
      {acting && (
        <form action={endImpersonation} className="mb-6 flex flex-wrap items-center justify-between gap-3 rounded-theme border border-warning/40 bg-warning/10 px-4 py-3 text-sm">
          <span>{t("{staff} is acting as {client}. Everything done here is recorded.", { staff: acting.name, client: user.email })}</span>
          <button className="cursor-pointer font-medium underline">{t("Return to the admin area")}</button>
        </form>
      )}
      {children}
    </PanelShell>
  );
}
