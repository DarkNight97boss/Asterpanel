import Link from "next/link";
import { logout } from "@/app/(auth)/actions";
import { getT } from "@/i18n";
import { displayName, type SessionUser } from "@/lib/auth";
import { Brand } from "./brand";
import { NavLink } from "./nav-link";

export type NavSection = { title?: string; items: { href: string; label: string; icon: string; exact?: boolean }[] };

/** Sidebar layout shared by the client area and the admin panel. */
export async function PanelShell({
  home,
  badge,
  nav,
  user,
  children,
}: {
  home: string;
  badge?: string;
  nav: NavSection[];
  user: SessionUser;
  children: React.ReactNode;
}) {
  const t = await getT();
  return (
    <div className="min-h-dvh bg-subtle lg:grid lg:grid-cols-[15rem_1fr]">
      <aside className="border-b border-border bg-surface lg:sticky lg:top-0 lg:h-dvh lg:overflow-y-auto lg:border-r lg:border-b-0">
        <div className="flex h-16 items-center gap-2 px-4">
          <Brand href={home} />
          {badge && <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-semibold tracking-wide text-primary uppercase">{badge}</span>}
        </div>
        <nav className="flex gap-1 overflow-x-auto px-3 pb-3 lg:block lg:space-y-5 lg:overflow-visible">
          {nav.map((section, i) => (
            <div key={i} className="flex gap-1 lg:block lg:space-y-0.5">
              {section.title && <p className="hidden px-3 pb-1 text-[11px] font-semibold tracking-wider text-muted uppercase lg:block">{section.title}</p>}
              {section.items.map((item) => (
                <NavLink key={item.href} href={item.href} exact={item.exact}>
                  <span aria-hidden>{item.icon}</span>
                  {item.label}
                </NavLink>
              ))}
            </div>
          ))}
        </nav>
      </aside>

      <div className="min-w-0">
        <header className="flex h-16 items-center justify-end gap-4 border-b border-border bg-surface px-4 sm:px-8">
          <Link href="/" className="text-sm text-muted hover:text-fg">
            {t("View site")} ↗
          </Link>
          <span className="hidden text-sm font-medium sm:inline">{displayName(user)}</span>
          <form action={logout}>
            <button className="cursor-pointer text-sm text-muted hover:text-fg">{t("Sign out")}</button>
          </form>
        </header>
        <main className="mx-auto max-w-6xl px-4 py-8 sm:px-8">{children}</main>
      </div>
    </div>
  );
}
