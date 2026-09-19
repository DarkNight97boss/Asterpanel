import Link from "next/link";
import { NavLink } from "@/components/nav-link";
import { ShellSlot } from "@/components/portal";
import { getT } from "@/i18n";
import { getAccount, roleCan } from "@/lib/account";
import { getSettings } from "@/lib/settings";

/** "Company settings": its own context, with its own menu in place of the main one. */
export default async function CompanyLayout({ children }: { children: React.ReactNode }) {
  const [{ account }, t] = await Promise.all([getAccount(), getT()]);
  const billing = roleCan(account.role, "billing");
  const referrals = (await getSettings("billing")).referralPercent > 0;
  const sections = [
    ...(billing ? [{ href: "/client/services", label: t("My plan") }, { href: "/client/invoices", label: t("Invoices") }, { href: "/client/quotes", label: t("Quotes") }, ...(referrals ? [{ href: "/client/company/referrals", label: t("Referrals") }] : []), { href: "/client/company/payment-methods", label: t("Payment methods") }, { href: "/client/company/details", label: t("Billing details") }] : []),
    { href: "/client/team", label: t("Users") },
    ...(roleCan(account.role, "manage") ? [{ href: "/client/company/api", label: t("API & webhooks") }, { href: "/client/company/variables", label: t("Variable groups") }] : []),
    { href: "/client/company/activity", label: t("User activity") },
  ];
  return (
    <>
      <ShellSlot slot="crumbs">
        <span className="text-white/40">/</span>
        <span className="truncate font-medium">{t("Company settings")}</span>
      </ShellSlot>
      <ShellSlot slot="context-nav">
        {sections.map((s) => <NavLink key={s.href} href={s.href}>{s.label}</NavLink>)}
        <Link href="/client" className="mt-4 hidden h-10 items-center px-4 text-sm text-muted hover:text-fg lg:flex">← {t("Dashboard")}</Link>
      </ShellSlot>
      {children}
    </>
  );
}
