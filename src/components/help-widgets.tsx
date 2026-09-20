"use client";

import { useEffect, useRef, useState } from "react";

type Article = { title: string; excerpt: string; href: string };

/** Under the subject of a new ticket: articles that may already answer it. Listens to the input it is given the name of. */
export function SuggestedArticles({ inputName, heading }: { inputName: string; heading: string }) {
  const [articles, setArticles] = useState<Article[]>([]);
  const anchor = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const input = anchor.current?.closest("form")?.querySelector<HTMLInputElement>(`[name="${inputName}"]`);
    if (!input) return;
    let timer: ReturnType<typeof setTimeout>;
    let latest = 0;
    const onInput = () => {
      clearTimeout(timer);
      timer = setTimeout(async () => {
        const q = input.value.trim();
        const mine = ++latest;
        const found = q.length < 4 ? [] : await fetch(`/api/help/suggest?q=${encodeURIComponent(q)}`).then((r) => r.json()).then((j) => (Array.isArray(j.articles) ? (j.articles as Article[]) : [])).catch(() => []);
        if (mine === latest) setArticles(found); // a slow, older answer must not replace a newer one
      }, 350);
    };
    input.addEventListener("input", onInput);
    return () => {
      clearTimeout(timer);
      input.removeEventListener("input", onInput);
    };
  }, [inputName]);
  return (
    <div ref={anchor}>
      {articles.length > 0 && (
        <div className="rounded-theme border border-border bg-paper p-4 text-sm">
          <p className="mb-2 font-medium">{heading}</p>
          <ul className="space-y-1.5">
            {articles.map((a) => (
              <li key={a.href}><a href={a.href} target="_blank" rel="noopener" className="font-medium text-link hover:underline">{a.title}</a>{a.excerpt && <span className="text-muted"> — {a.excerpt.slice(0, 120)}</span>}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/** At the foot of a help article. */
export function HelpfulVote({ slug, labels }: { slug: string; labels: { question: string; yes: string; no: string; thanks: string } }) {
  const [done, setDone] = useState(false);
  const vote = (helpful: boolean) => {
    setDone(true);
    void fetch("/api/help/vote", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ slug, helpful }) }).catch(() => {});
  };
  return (
    <div className="mx-auto mt-10 flex max-w-3xl flex-wrap items-center gap-3 border-t border-border px-6 pt-6 text-sm text-body">
      {done ? <span>{labels.thanks}</span> : (
        <>
          <span>{labels.question}</span>
          <button type="button" onClick={() => vote(true)} className="rounded-theme border border-border px-3 py-1 hover:border-accent">{labels.yes}</button>
          <button type="button" onClick={() => vote(false)} className="rounded-theme border border-border px-3 py-1 hover:border-accent">{labels.no}</button>
        </>
      )}
    </div>
  );
}
