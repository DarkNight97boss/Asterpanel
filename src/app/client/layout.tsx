import { PanelShell } from "@/components/panel-shell";
import { getT } from "@/i18n";
import { requireUser } from "@/lib/auth";
import { ensureInstalled } from "@/lib/install";

export const metadata = { title: "Client area" };

export default async function ClientLayout({ children }: { children: React.ReactNode }) {
  await ensureInstalled();
  const [user, t] = await Promise.all([requireUser("/client"), getT()]);
  return (
    <PanelShell
      home="/client"
      user={user}
      nav={[
        {
          items: [
            { href: "/client", label: t("Dashboard"), icon: "◧", exact: true },
            { href: "/client/services", label: t("Services"), icon: "▤" },
            { href: "/client/invoices", label: t("Invoices"), icon: "▦" },
            { href: "/client/tickets", label: t("Support"), icon: "✉" },
            { href: "/client/profile", label: t("Profile"), icon: "☺" },
          ],
        },
      ]}
    >
      {children}
    </PanelShell>
  );
}
