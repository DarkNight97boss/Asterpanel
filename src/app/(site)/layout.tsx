import Link from "next/link";
import { asc } from "drizzle-orm";
import { Brand } from "@/components/brand";
import { safeHref } from "@/cms/blocks";
import { getDb, schema } from "@/db";
import { getT } from "@/i18n";
import { getUser, isStaff } from "@/lib/auth";
import { ensureInstalled } from "@/lib/install";
import { getSettings } from "@/lib/settings";

export default async function SiteLayout({ children }: { children: React.ReactNode }) {
  await ensureInstalled();
  const db = await getDb();
  const [menu, user, t, general, theme] = await Promise.all([
    db.select().from(schema.menuItems).orderBy(asc(schema.menuItems.position)),
    getUser(),
    getT(),
    getSettings("general"),
    getSettings("theme"),
  ]);
  const header = menu.filter((m) => m.location === "header");
  const footer = menu.filter((m) => m.location === "footer");
  const columns = Map.groupBy(footer.filter((m) => m.columnTitle), (m) => m.columnTitle);
  const bottom = footer.filter((m) => !m.columnTitle);
  const pill = "inline-flex h-9 items-center rounded-theme px-4 text-sm transition";

  return (
    <div className="flex min-h-dvh flex-col">
      {theme.announcement && (
        <a href={safeHref(theme.announcementHref || "#")} className="block bg-accent/70 px-4 py-2 text-center text-sm text-fg hover:bg-accent/80">
          {theme.announcement}
        </a>
      )}
      {/* Floating dark bar. */}
      <header className="sticky top-0 z-30 px-3 pt-2 sm:px-6">
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-6 rounded-theme bg-ink px-4 text-white shadow-[0_10px_30px_-15px_rgba(0,0,0,0.5)] sm:px-5">
          <Brand variant="ink" />
          <nav className="hidden flex-1 items-center justify-center gap-7 text-sm md:flex">
            {header.map((m) => (
              <Link key={m.id} href={safeHref(m.href)} className="text-white/85 transition hover:text-white">
                {m.label}
              </Link>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-1">
            {user ? (
              <Link href={isStaff(user) ? "/admin" : "/client"} className={`${pill} bg-white text-ink hover:bg-white/90`}>
                {isStaff(user) ? t("Admin") : t("Dashboard")}
              </Link>
            ) : (
              <>
                <Link href="/login" className={`${pill} text-white/85 hover:text-white`}>{t("Sign in")}</Link>
                {general.allowRegistration && <Link href="/register" className={`${pill} bg-white text-ink hover:bg-white/90`}>{t("Get started")}</Link>}
              </>
            )}
          </div>
        </div>
      </header>

      <main className="flex-1">{children}</main>

      <footer className="mt-16 border-t border-border">
        <div className="mx-auto max-w-6xl px-6 py-14">
          {columns.size > 0 && (
            <div className="mb-14 grid gap-10 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-5">
              {[...columns].map(([title, links]) => (
                <div key={title}>
                  <h3 className="mb-4 text-xl font-medium">{title}</h3>
                  <ul className="space-y-2.5">
                    {links.map((m) => (
                      <li key={m.id}>
                        <Link href={safeHref(m.href)} className="hover:text-fg hover:underline">{m.label}</Link>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          )}
          <div className="flex flex-wrap items-center justify-between gap-5 text-sm">
            <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
              <Brand />
              <span className="text-muted">{theme.footerText || `© ${new Date().getFullYear()} ${general.companyName || general.siteName}`}</span>
            </div>
            <nav className="flex flex-wrap gap-5 text-muted">
              {bottom.map((m) => (
                <Link key={m.id} href={safeHref(m.href)} className="hover:text-fg">{m.label}</Link>
              ))}
            </nav>
          </div>
        </div>
      </footer>
    </div>
  );
}
