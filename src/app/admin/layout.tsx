import { PanelShell } from "@/components/panel-shell";
import { getT } from "@/i18n";
import { requireStaff } from "@/lib/auth";
import { ensureInstalled } from "@/lib/install";

export const metadata = { title: "Admin" };

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  await ensureInstalled();
  const [user, t] = await Promise.all([requireStaff(), getT()]);
  const admin = user.role === "admin";
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
            { href: "/admin/workloads", label: t("Workloads"), icon: "▣" },
            ...(admin ? [{ href: "/admin/nodes", label: t("Nodes"), icon: "▥" }] : []),
            { href: "/admin/jobs", label: t("Jobs"), icon: "⟳" },
            ...(admin ? [{ href: "/admin/dns", label: "DNS", icon: "⇄" }] : []),
          ],
        },
        {
          title: t("Business"),
          items: [
            { href: "/admin/clients", label: t("Clients"), icon: "☺" },
            { href: "/admin/orders", label: t("Orders"), icon: "◈" },
            { href: "/admin/services", label: t("Services"), icon: "▤" },
            { href: "/admin/invoices", label: t("Invoices"), icon: "▦" },
            { href: "/admin/tickets", label: t("Tickets"), icon: "✉" },
          ],
        },
        {
          title: t("Catalog"),
          items: [
            { href: "/admin/products", label: t("Products"), icon: "❖" },
            ...(admin ? [{ href: "/admin/servers", label: t("External servers"), icon: "▤" }] : []),
          ],
        },
        {
          title: t("Website"),
          items: [
            { href: "/admin/pages", label: t("Pages"), icon: "▧" },
            { href: "/admin/menus", label: t("Menus"), icon: "☰" },
            ...(admin ? [{ href: "/admin/settings/appearance", label: t("Appearance"), icon: "◐" }] : []),
          ],
        },
        {
          title: t("System"),
          items: [
            { href: "/admin/automation", label: t("Automation"), icon: "⟳" },
            ...(admin
              ? [
                  { href: "/admin/settings", label: t("Settings"), icon: "⚙", exact: true },
                  { href: "/admin/settings/billing", label: t("Billing"), icon: "¤" },
                  { href: "/admin/settings/gateways", label: t("Payment gateways"), icon: "▭" },
                  { href: "/admin/settings/mail", label: t("Email"), icon: "@" },
                  { href: "/admin/settings/backups", label: t("Backups"), icon: "⛁" },
                ]
              : []),
          ],
        },
      ]}
    >
      {children}
    </PanelShell>
  );
}
