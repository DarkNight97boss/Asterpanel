import Link from "next/link";
import { getT } from "@/i18n";
import { searchPages } from "@/lib/pages";
import { getSettings } from "@/lib/settings";

export const metadata = { title: "Search the help centre", robots: { index: false } };

export default async function HelpSearch({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const q = ((await searchParams).q ?? "").slice(0, 200);
  const [t, { helpPrefix }] = await Promise.all([getT(), getSettings("general")]);
  const results = helpPrefix && q ? await searchPages(helpPrefix, q, 20) : [];
  return (
    <section className="mx-auto max-w-3xl px-6 py-16">
      <h1 className="text-3xl font-semibold">{t("Search the help centre")}</h1>
      <form className="mt-6 flex gap-3">
        <input name="q" defaultValue={q} required minLength={3} autoFocus placeholder={t("What do you need help with?")} className="min-w-0 flex-1 rounded-theme border border-border bg-surface px-4 py-2.5" />
        <button className="rounded-theme bg-accent px-5 py-2.5 font-medium text-white">{t("Search")}</button>
      </form>
      {q && (
        <ul className="mt-8 divide-y divide-border">
          {results.map((r) => (
            <li key={r.slug} className="py-4">
              <Link href={`/${r.slug}`} className="text-lg font-medium text-link hover:underline">{r.title}</Link>
              {r.excerpt && <p className="mt-1 text-sm text-body">{r.excerpt}</p>}
            </li>
          ))}
          {!results.length && <li className="py-4 text-body">{t("Nothing found. Try other words, or open a ticket: we are glad to help.")}</li>}
        </ul>
      )}
    </section>
  );
}
