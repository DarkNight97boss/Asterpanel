import Link from "next/link";
import { asc } from "drizzle-orm";
import { Brand } from "@/components/brand";
import { ButtonLink } from "@/components/ui";
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

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="sticky top-0 z-30 border-b border-border bg-bg/85 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-6xl items-center gap-6 px-4">
          <Brand />
          <nav className="hidden flex-1 items-center gap-6 text-sm md:flex">
            {header.map((m) => (
              <Link key={m.id} href={safeHref(m.href)} className="text-muted transition hover:text-fg">
                {m.label}
              </Link>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-2">
            {user ? (
              <ButtonLink href={isStaff(user) ? "/admin" : "/client"} size="sm">
                {isStaff(user) ? t("Admin") : t("Client area")}
              </ButtonLink>
            ) : (
              <>
                <ButtonLink href="/login" size="sm" variant="ghost">
                  {t("Sign in")}
                </ButtonLink>
                {general.allowRegistration && (
                  <ButtonLink href="/register" size="sm">
                    {t("Get started")}
                  </ButtonLink>
                )}
              </>
            )}
          </div>
        </div>
      </header>

      <main className="flex-1">{children}</main>

      <footer className="border-t border-border bg-subtle">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-4 py-8 text-sm text-muted">
          <p>{theme.footerText || `© ${new Date().getFullYear()} ${general.companyName || general.siteName}`}</p>
          <nav className="flex flex-wrap gap-5">
            {footer.map((m) => (
              <Link key={m.id} href={safeHref(m.href)} className="hover:text-fg">
                {m.label}
              </Link>
            ))}
          </nav>
        </div>
      </footer>
    </div>
  );
}
