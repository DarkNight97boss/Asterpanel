import Link from "next/link";
import { logout } from "@/app/(auth)/actions";
import { switchAccount } from "@/app/client/team/actions";
import { getT } from "@/i18n";
import { ROLE_LABEL, type Account } from "@/lib/account";
import { displayName, type SessionUser } from "@/lib/auth";
import { getSettings } from "@/lib/settings";
import { Brand } from "./brand";
import { NavLink } from "./nav-link";

export type NavSection = { title?: string; items: { href: string; label: string; icon: string; exact?: boolean }[] };

/**
 * App chrome: a floating dark top bar (brand · breadcrumb · user) over a light
 * sidebar and the content. Nested layouts can fill `#shell-crumbs` and replace
 * the main navigation through `#shell-context-nav` (see ShellSlot).
 */
export async function PanelShell({
  home,
  badge,
  nav,
  user,
  account,
  accounts = [],
  alerts,
  children,
}: {
  home: string;
  badge?: string;
  nav: NavSection[];
  user: SessionUser;
  /** Client area only: the active account and the ones the user can switch to. */
  account?: Account;
  accounts?: Account[];
  /** Client area only: enables the search box and the bell with this many open items. */
  alerts?: number;
  children: React.ReactNode;
}) {
  const [t, general] = await Promise.all([getT(), getSettings("general")]);
  const name = displayName(user);
  return (
    <div className="app mx-auto min-h-dvh max-w-[90rem] px-3 sm:px-5">
      <header className="sticky top-0 z-30 pt-4">
        <div className="flex h-14 items-center gap-4 rounded-theme bg-primary px-4 text-white shadow-[0_10px_30px_-18px_rgba(0,0,0,0.55)] sm:px-5">
          <div className="flex shrink-0 items-center gap-2 lg:w-[13.5rem]">
            <Brand href={home} variant="ink" />
            {badge && <span className="rounded-full bg-white/15 px-2 py-0.5 text-[10px] font-medium tracking-wide uppercase">{badge}</span>}
          </div>
          <nav aria-label="Breadcrumb" className="flex min-w-0 flex-1 items-center gap-3 text-sm">
            <Link href={home} aria-label={t("Dashboard")} className="text-white/90 hover:text-white">⌂</Link>
            {account && accounts.length > 1 ? (
              <details className="relative min-w-0">
                <summary className="flex cursor-pointer list-none items-center gap-1.5 truncate">{account.name} <span aria-hidden className="text-xs">⌄</span></summary>
                <form action={switchAccount} className="absolute left-0 z-10 mt-3 w-64 rounded-theme border border-border bg-surface p-1.5 text-fg shadow-xl">
                  {accounts.map((a) => (
                    <button key={a.id} name="accountId" value={a.id} className="flex w-full cursor-pointer items-center justify-between gap-3 rounded-md px-3 py-2 text-left hover:bg-subtle">
                      <span className="truncate">{a.name}</span>
                      <span className="shrink-0 text-xs text-muted">{a.id === account.id ? "✓" : t(ROLE_LABEL[a.role])}</span>
                    </button>
                  ))}
                </form>
              </details>
            ) : (
              <span className="truncate">{account?.name || user.company || general.companyName || general.siteName}</span>
            )}
            <span id="shell-crumbs" className="flex min-w-0 items-center gap-3 empty:hidden" />
          </nav>
          <div className="flex shrink-0 items-center gap-4 text-sm">
            {alerts !== undefined && (
              <>
                <form action="/client/search" role="search" className="hidden md:block">
                  <input name="q" type="search" placeholder={t("Search…")} aria-label={t("Search")} className="h-8 w-44 rounded-md border border-white/20 bg-white/10 px-3 text-sm text-white placeholder:text-white/50 focus:w-64 focus:border-white/50 focus:outline-none" />
                </form>
                <Link href="/client/notifications" aria-label={t("Notifications")} className="relative grid size-7 place-items-center rounded-full hover:bg-white/10">
                  <svg viewBox="0 0 24 24" className="size-[1.1rem]" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M6 8a6 6 0 1 1 12 0c0 7 3 8 3 8H3s3-1 3-8" /><path d="M10 21a2 2 0 0 0 4 0" /></svg>
                  {alerts > 0 && <span className="absolute -top-1 -right-1 grid h-4 min-w-4 place-items-center rounded-full bg-accent px-1 text-[10px] leading-none font-semibold text-white">{alerts > 9 ? "9+" : alerts}</span>}
                </Link>
              </>
            )}
            <Link href="/" className="hidden text-white/80 hover:text-white md:inline">{t("View site")} ↗</Link>
            <Link href="/client/tickets" aria-label={t("Support")} className="grid size-6 place-items-center rounded-full border border-white/70 text-xs hover:bg-white/10">?</Link>
            <details className="relative">
              <summary className="flex cursor-pointer list-none items-center gap-2">
                <span className="grid size-7 place-items-center rounded-full bg-accent text-xs font-semibold text-white">{name.slice(0, 1).toUpperCase()}</span>
                <span className="hidden max-w-40 truncate sm:inline">{name}</span>
                <span aria-hidden className="text-xs">⌄</span>
              </summary>
              <div className="absolute right-0 mt-3 w-52 rounded-theme border border-border bg-surface p-1.5 text-fg shadow-xl">
                <Link href="/client/profile" className="block rounded-md px-3 py-2 hover:bg-subtle">{t("Profile")}</Link>
                <form action={logout}>
                  <button className="block w-full cursor-pointer rounded-md px-3 py-2 text-left hover:bg-subtle">{t("Sign out")}</button>
                </form>
              </div>
            </details>
          </div>
        </div>
      </header>

      <div className="gap-4 pt-8 lg:grid lg:grid-cols-[15rem_1fr]">
        <aside className="mb-6 lg:sticky lg:top-24 lg:mb-0 lg:h-[calc(100dvh-7rem)] lg:overflow-y-auto lg:pr-2">
          {/* A nested layout may portal its own menu here; the main one then hides. */}
          <div id="shell-context-nav" className="peer flex gap-1 overflow-x-auto empty:hidden lg:block lg:space-y-1" />
          <nav className="flex gap-1 overflow-x-auto peer-[:not(:empty)]:hidden lg:block lg:space-y-5">
            {nav.map((section, i) => (
              <div key={i} className="flex gap-1 lg:block lg:space-y-1">
                {section.title && <p className="hidden px-4 pt-1 pb-1 text-xs text-muted lg:block">{section.title}</p>}
                {section.items.map((item) => (
                  <NavLink key={item.href} href={item.href} exact={item.exact}>
                    <span aria-hidden className="w-[1.125rem] text-center text-[0.95rem] leading-none">{item.icon}</span>
                    {item.label}
                  </NavLink>
                ))}
              </div>
            ))}
          </nav>
        </aside>
        <main className="min-w-0 pb-20">{children}</main>
      </div>
    </div>
  );
}
