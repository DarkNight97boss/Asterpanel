import { desc, gte, isNull, or } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { getLocale, getT } from "@/i18n";
import { formatDateTime } from "@/lib/format";

export const metadata = { title: "Status" };

const DAYS = 90;
const since = () => new Date(Date.now() - DAYS * 86_400_000);

/** Public, deliberately free of infrastructure detail: only what staff chose to publish. */
export default async function Status() {
  const [t, locale, rows] = await Promise.all([getT(), getLocale(), (await getDb()).select().from(schema.incidents).where(or(isNull(schema.incidents.resolvedAt), gte(schema.incidents.startedAt, since()))).orderBy(desc(schema.incidents.startedAt)).limit(50)]);
  const open = rows.filter((i) => i.status !== "resolved");
  const worst = open.some((i) => i.impact === "major") ? "major" : open.some((i) => i.impact === "minor") ? "minor" : open.length ? "maintenance" : "ok";
  const banner = { ok: ["bg-success/10 text-success", "All systems operational"], maintenance: ["bg-subtle text-fg", "Maintenance in progress"], minor: ["bg-warning/15 text-fg", "Some systems are degraded"], major: ["bg-danger/10 text-danger", "Major outage"] }[worst];

  return (
    <div className="mx-auto max-w-3xl px-5 py-16">
      <h1 className="text-4xl">{t("Status")}</h1>
      <p className={`mt-6 rounded-theme px-5 py-4 text-lg font-medium ${banner[0]}`}>● {t(banner[1])}</p>

      {open.length > 0 && <h2 className="mt-12 text-2xl">{t("Happening now")}</h2>}
      {open.map((i) => <Incident key={i.id} i={i} locale={locale} t={t} />)}

      <h2 className="mt-12 text-2xl">{t("Past {n} days", { n: DAYS })}</h2>
      {rows.filter((i) => i.status === "resolved").length ? rows.filter((i) => i.status === "resolved").map((i) => <Incident key={i.id} i={i} locale={locale} t={t} />) : <p className="mt-4 text-muted">{t("No incidents")}</p>}
    </div>
  );
}

function Incident({ i, locale, t }: { i: typeof schema.incidents.$inferSelect; locale: string; t: (s: string) => string }) {
  return (
    <article className="mt-5 rounded-theme border border-border bg-surface p-5">
      <h3 className="text-lg font-medium">{i.title} <span className="ml-2 text-sm font-normal text-muted">{t(i.impact === "maintenance" ? "Maintenance" : i.impact === "major" ? "Major" : "Minor")}</span></h3>
      <ul className="mt-3 space-y-2 text-sm">
        {[...i.updates].reverse().map((u, n) => (
          <li key={n}><strong className="font-medium">{t(u.status)}</strong> — {u.message} <span className="block text-xs text-muted">{formatDateTime(new Date(u.at), locale)}</span></li>
        ))}
      </ul>
    </article>
  );
}
