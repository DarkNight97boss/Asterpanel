import { PanelShell } from "@/components/panel-shell";
import { getT } from "@/i18n";
import { requireStaff } from "@/lib/auth";
import { ensureInstalled } from "@/lib/install";
import { staffCan, type StaffArea } from "@/lib/staff";

export const metadata = { title: "Admin" };

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  await ensureInstalled();
  const [user, t] = await Promise.all([requireStaff(), getT()]);
  const admin = user.role === "admin";
  const can = (area: StaffArea) => staffCan(user, area);
  return (
    <PanelShell
      home="/admin"
      badge="Admin"
      user={user}
      nav={[
        { items: [{ href: "/admin", label: t("Dashboard"), icon: "◧", exact: true }] },
        {
          title: t("Platform"),
          items: [
            ...(can("platform") ? [{ href: "/admin/workloads", label: t("Workloads"), icon: "▣" }] : []),
            ...(admin ? [{ href: "/admin/nodes", label: t("Nodes"), icon: "▥" }] : []),
            ...(can("platform") ? [{ href: "/admin/jobs", label: t("Jobs"), icon: "⟳" }, { href: "/admin/status", label: t("Status page"), icon: "◉" }] : []),
            ...(admin ? [{ href: "/admin/dns", label: "DNS", icon: "⇄" }] : []),
          ],
        },
        {
          title: t("Business"),
          items: [
            ...(can("clients") ? [{ href: "/admin/clients", label: t("Clients"), icon: "☺" }] : []),
            ...(can("billing") ? [{ href: "/admin/orders", label: t("Orders"), icon: "◈" }, { href: "/admin/services", label: t("Services"), icon: "▤" }, { href: "/admin/invoices", label: t("Invoices"), icon: "▦" }, { href: "/admin/quotes", label: t("Quotes"), icon: "✎" }, { href: "/admin/reports", label: t("Reports"), icon: "◔" }] : []),
            ...(can("support") ? [{ href: "/admin/tickets", label: t("Tickets"), icon: "✉" }, { href: "/admin/canned-replies", label: t("Canned replies"), icon: "❝" }] : []),
          ],
        },
        {
          title: t("Catalog"),
          items: [
            ...(can("billing") ? [{ href: "/admin/products", label: t("Products"), icon: "❖" }, { href: "/admin/domains", label: t("Domains"), icon: "◍" }, { href: "/admin/coupons", label: t("Discount codes"), icon: "%" }] : []),
            ...(admin ? [{ href: "/admin/servers", label: t("External servers"), icon: "▤" }] : []),
          ],
        },
        {
          title: t("Website"),
          items: [
            ...(can("content") ? [{ href: "/admin/pages", label: t("Pages"), icon: "▧" }, { href: "/admin/menus", label: t("Menus"), icon: "☰" }] : []),
            ...(admin ? [{ href: "/admin/settings/appearance", label: t("Appearance"), icon: "◐" }] : []),
          ],
        },
        {
          title: t("System"),
          items: [
            ...(can("billing") ? [{ href: "/admin/automation", label: t("Automation"), icon: "⟳" }] : []),
            ...(admin
              ? [
                  { href: "/admin/settings", label: t("Settings"), icon: "⚙", exact: true },
                  { href: "/admin/settings/billing", label: t("Billing"), icon: "¤" },
                  { href: "/admin/settings/einvoice", label: t("Electronic invoicing"), icon: "⌘" },
                  { href: "/admin/settings/gateways", label: t("Payment gateways"), icon: "▭" },
                  { href: "/admin/settings/mail", label: t("Email"), icon: "@" },
                  { href: "/admin/settings/github", label: "GitHub", icon: "⑂" },
                  { href: "/admin/settings/cloud", label: t("Infrastructure"), icon: "☁" },
                  { href: "/admin/settings/ip-pools", label: t("IP address pools"), icon: "⌗" },
                  { href: "/admin/settings/ipxo", label: t("IP leasing (IPXO)"), icon: "⇄" },
                  { href: "/admin/settings/registrars", label: t("Domain registrars"), icon: "◍" },
                  { href: "/admin/settings/backups", label: t("Backups"), icon: "⛁" },
                  { href: "/admin/staff", label: t("Staff"), icon: "⚇" },
                ]
              : []),
          ],
        },
      ].filter((section) => section.items.length)}
    >
      {children}
    </PanelShell>
  );
}
