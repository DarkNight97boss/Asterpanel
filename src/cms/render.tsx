import "server-only";
import { and, asc, eq } from "drizzle-orm";
import { ButtonLink, cn } from "@/components/ui";
import { getDb, schema } from "@/db";
import { getLocale, getT } from "@/i18n";
import { CYCLE_SUFFIX, formatMoney, headlineCycle } from "@/lib/format";
import { getSettings } from "@/lib/settings";
import { items, safeHref, str, type Block } from "./blocks";
import { Calculator } from "./calculator";
import { Markdown } from "./markdown";

const Section = ({ id, className, children }: { id?: string; className?: string; children: React.ReactNode }) => (
  <section id={id} className={cn("px-4 py-16 sm:py-20", className)}>
    <div className="mx-auto max-w-6xl">{children}</div>
  </section>
);

/** Centered section heading; an optional second line is set in a muted tone. */
function Heading({ title, muted, subtitle, eyebrow }: { title: string; muted?: string; subtitle?: string; eyebrow?: string }) {
  if (!title && !subtitle) return null;
  return (
    <div className="mx-auto mb-14 max-w-3xl text-center">
      {eyebrow && <p className="mb-4 text-sm font-medium text-link">{eyebrow}</p>}
      {title && (
        <h2 className="font-display text-4xl leading-[1.1] text-balance sm:text-5xl">
          {title}
          {muted && <span className="block text-muted">{muted}</span>}
        </h2>
      )}
      {subtitle && <p className="mx-auto mt-5 max-w-xl text-lg">{subtitle}</p>}
    </div>
  );
}

function Hero({ props: p }: { props: Block["props"] }) {
  const centered = p.align === "center";
  return (
    <section className="relative overflow-hidden px-4 pt-16 pb-20 sm:pt-24 sm:pb-28">
      {/* Decorative grid of soft squares, top right. */}
      <div
        aria-hidden
        className="pointer-events-none absolute -top-6 right-0 -z-10 hidden h-[30rem] w-[34rem] opacity-70 md:block"
        style={{
          backgroundImage: "linear-gradient(var(--bg) 3px, transparent 3px), linear-gradient(90deg, var(--bg) 3px, transparent 3px)",
          backgroundSize: "44px 44px",
          backgroundColor: "var(--bg-subtle)",
          maskImage: "radial-gradient(ellipse at top right, #000 25%, transparent 70%)",
        }}
      />
      <div className={cn("mx-auto grid max-w-6xl items-center gap-14", !centered && "lg:grid-cols-[1.05fr_1fr]")}>
        <div className={cn(centered && "mx-auto max-w-3xl text-center")}>
          {str(p.eyebrow) && <p className="mb-5 text-sm font-medium text-link">{str(p.eyebrow)}</p>}
          <h1 className="text-5xl leading-[1.08] text-balance sm:text-6xl lg:text-[4rem]">{str(p.title)}</h1>
          {str(p.subtitle) && <p className={cn("mt-6 max-w-xl text-xl leading-relaxed text-fg/85", centered && "mx-auto")}>{str(p.subtitle)}</p>}
          <div className={cn("mt-9 flex flex-wrap gap-3", centered && "justify-center")}>
            {str(p.primaryLabel) && (
              <ButtonLink href={safeHref(p.primaryHref)} size="lg">
                {str(p.primaryLabel)} <span aria-hidden>→</span>
              </ButtonLink>
            )}
            {str(p.secondaryLabel) && (
              <ButtonLink href={safeHref(p.secondaryHref)} size="lg" variant="secondary">
                {str(p.secondaryLabel)}
              </ButtonLink>
            )}
          </div>
        </div>

        {!centered && (
          <div className="relative hidden lg:block">
            {str(p.imageUrl) ? (
              // eslint-disable-next-line @next/next/no-img-element -- editor-provided URL on any host
              <img src={safeHref(p.imageUrl)} alt="" className="aspect-[4/5] w-full rounded-panel border border-border object-cover" />
            ) : (
              <div className="rounded-panel border border-border bg-surface p-5 shadow-[0_30px_80px_-30px_rgba(28,24,25,0.35)]">
                <div className="flex items-center justify-between border-b border-border pb-4">
                  <span className="font-medium text-fg">my-site.com</span>
                  <span className="rounded-full bg-success/10 px-2.5 py-0.5 text-xs font-medium text-success">● Live</span>
                </div>
                <dl className="grid grid-cols-3 gap-4 py-5 text-center">
                  {[["99.99%", "Uptime"], ["212 ms", "Response"], ["A+", "SSL"]].map(([v, l]) => (
                    <div key={l}>
                      <dd className="font-display text-3xl">{v}</dd>
                      <dt className="mt-1 text-xs font-normal text-muted">{l}</dt>
                    </div>
                  ))}
                </dl>
                <svg viewBox="0 0 320 90" className="w-full" aria-hidden>
                  <path d="M0 62 C40 58 50 30 85 34 S130 70 165 52 210 18 245 30 290 60 320 40" fill="none" stroke="var(--accent)" strokeWidth="2.5" strokeLinecap="round" />
                  <path d="M0 62 C40 58 50 30 85 34 S130 70 165 52 210 18 245 30 290 60 320 40 V90 H0Z" fill="var(--accent)" opacity="0.08" />
                </svg>
              </div>
            )}
            <div className="absolute -top-10 -right-8 grid size-20 place-items-center rounded-card border border-border bg-[#e9f9ee] text-3xl text-success shadow-lg">♥</div>
            <div className="absolute -bottom-5 -left-6 rounded-card border border-border bg-surface px-4 py-3 text-sm shadow-lg">
              <span className="text-muted">Staging → Live</span> <span className="ml-2 font-medium text-success">✓ 38s</span>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

async function Pricing({ props: p }: { props: Block["props"] }) {
  const groupId = str(p.groupId);
  if (!/^[0-9a-f-]{36}$/i.test(groupId)) return null;
  const db = await getDb();
  const [plans, billing, t, locale] = await Promise.all([
    db.query.products.findMany({
      where: and(eq(schema.products.groupId, groupId), eq(schema.products.hidden, false)),
      orderBy: [asc(schema.products.position), asc(schema.products.name)],
    }),
    getSettings("billing"),
    getT(),
    getLocale(),
  ]);
  if (!plans.length) return null;

  return (
    <Section id="pricing">
      <Heading title={str(p.title)} muted={str(p.titleMuted)} subtitle={str(p.subtitle)} />
      <div className={cn("mx-auto grid gap-8", plans.length >= 3 ? "lg:grid-cols-3" : "max-w-3xl sm:grid-cols-2", plans.length === 1 && "max-w-sm sm:grid-cols-1")}>
        {plans.map((plan) => {
          const cycle = headlineCycle(plan.pricing);
          return (
            <div
              key={plan.id}
              className={cn(
                "relative flex flex-col rounded-panel border bg-surface p-8",
                plan.featured ? "border-fg shadow-[0_30px_80px_-40px_rgba(28,24,25,0.5)]" : "border-border",
              )}
            >
              {plan.featured && (
                <span className="absolute -top-3 left-7 rounded-full bg-accent px-3 py-0.5 text-xs font-medium text-white">
                  {t("Most popular")}
                </span>
              )}
              <h3 className="text-lg font-semibold">{plan.name}</h3>
              {plan.tagline && <p className="mt-1 text-sm text-muted">{plan.tagline}</p>}
              {cycle && (
                <p className="mt-6 flex items-baseline gap-1">
                  <span className="font-display text-5xl">{formatMoney(plan.pricing[cycle]!, billing.currency, locale)}</span>
                  <span className="text-sm text-muted">{t(CYCLE_SUFFIX[cycle])}</span>
                </p>
              )}
              <ul className="mt-6 mb-8 flex-1 space-y-2.5 text-sm">
                {plan.features.map((f, i) => (
                  <li key={i} className="flex gap-2.5">
                    <span aria-hidden className="font-bold text-link">✓</span>
                    {f}
                  </li>
                ))}
              </ul>
              <ButtonLink href={`/order/${plan.slug}`} variant={plan.featured ? "primary" : "secondary"} className="w-full">
                {t("Order now")}
              </ButtonLink>
            </div>
          );
        })}
      </div>
    </Section>
  );
}

const Eyebrow = ({ text }: { text: string }) => (text ? <p className="mb-3 text-sm font-semibold tracking-wide text-link uppercase">{text}</p> : null);

function Services({ props: p }: { props: Block["props"] }) {
  const list = items(p.items);
  return (
    <Section>
      <Heading eyebrow={str(p.eyebrow)} title={str(p.title)} muted={str(p.titleMuted)} subtitle={str(p.subtitle)} />
      <div className={cn("grid gap-6 sm:grid-cols-2", list.length >= 4 && "xl:grid-cols-4")}>
        {list.map((s, i) => (
          <a key={i} href={safeHref(s.href)} className="group flex flex-col rounded-panel border border-border bg-surface p-8 transition hover:-translate-y-0.5 hover:shadow-[0_24px_60px_-30px_rgba(28,24,25,0.35)]">
            {str(s.icon) && <span className="mb-6 grid size-12 place-items-center rounded-card bg-subtle text-2xl text-fg">{str(s.icon)}</span>}
            <h3 className="text-xl font-medium">{str(s.title)}</h3>
            <p className="mt-2 flex-1 leading-relaxed">{str(s.text)}</p>
            {str(s.linkLabel) && <span className="mt-6 text-fg underline decoration-border underline-offset-4 group-hover:decoration-accent">{str(s.linkLabel)} <span className="inline-block transition group-hover:translate-x-1">→</span></span>}
          </a>
        ))}
      </div>
    </Section>
  );
}

function Split({ props: p }: { props: Block["props"] }) {
  const left = p.side === "left";
  return (
    <Section>
      <div className="grid items-center gap-12 lg:grid-cols-2">
        <div className={cn(left && "lg:order-2")}>
          <Eyebrow text={str(p.eyebrow)} />
          <h2 className="font-display text-4xl leading-[1.1] text-balance sm:text-5xl">{str(p.title)}</h2>
          {str(p.text) && <p className="mt-5 text-lg leading-relaxed">{str(p.text)}</p>}
          <ul className="mt-6 space-y-3">
            {items(p.bullets).map((b, i) => (
              <li key={i} className="flex gap-3">
                <span aria-hidden className="mt-0.5 grid size-5 shrink-0 place-items-center rounded-full bg-accent/15 text-xs font-bold text-link">✓</span>
                {str(b.text)}
              </li>
            ))}
          </ul>
          {str(p.label) && <ButtonLink href={safeHref(p.href)} className="mt-8">{str(p.label)}</ButtonLink>}
        </div>
        <div className="overflow-hidden rounded-panel bg-ink shadow-[0_30px_80px_-30px_rgba(28,24,25,0.6)]">
          <div className="flex items-center gap-1.5 border-b border-white/10 px-4 py-3">
            <span className="size-2.5 rounded-full bg-[#ff5f57]" /><span className="size-2.5 rounded-full bg-[#febc2e]" /><span className="size-2.5 rounded-full bg-[#28c840]" />
            <span className="ml-3 font-mono text-xs text-white/40">{str(p.panelTitle)}</span>
          </div>
          <pre className="overflow-x-auto p-5 font-mono text-[13px] leading-7 text-ink-fg">
            {str(p.panel).split("\n").map((line, i) => (
              <span key={i} className={cn("block", line.startsWith("✓") && "text-[#4ade80]", line.startsWith("$") && "text-white", line.startsWith("→") && "text-white/55")}>{line || " "}</span>
            ))}
          </pre>
        </div>
      </div>
    </Section>
  );
}

function Logos({ props: p }: { props: Block["props"] }) {
  const list = items(p.items);
  if (!list.length) return null;
  return (
    <section className="px-4 py-12">
      <div className="mx-auto max-w-6xl text-center">
        {str(p.title) && <p className="mb-7 text-sm text-muted">{str(p.title)}</p>}
        <ul className="flex flex-wrap items-center justify-center gap-x-10 gap-y-4">
          {list.map((l, i) => (
            <li key={i} className="text-lg font-semibold tracking-tight text-muted/70">{str(l.name)}</li>
          ))}
        </ul>
      </div>
    </section>
  );
}

function Features({ props: p }: { props: Block["props"] }) {
  return (
    <Section>
      <Heading title={str(p.title)} muted={str(p.titleMuted)} subtitle={str(p.subtitle)} />
      <div className="grid gap-8 md:grid-cols-3">
        {items(p.items).map((f, i) => (
          <article key={i} className="flex flex-col rounded-panel border border-border bg-surface p-8">
            <figure className="mb-7 grid aspect-[4/3] place-items-center overflow-hidden rounded-card bg-subtle">
              {str(f.imageUrl) ? (
                // eslint-disable-next-line @next/next/no-img-element -- editor-provided URL on any host
                <img src={safeHref(f.imageUrl)} alt="" loading="lazy" className="size-full object-cover" />
              ) : (
                <span aria-hidden className="grid size-20 place-items-center rounded-panel border border-border bg-surface text-4xl shadow-[0_18px_40px_-20px_rgba(28,24,25,0.4)]">{str(f.icon) || "✦"}</span>
              )}
            </figure>
            <h3 className="text-xl leading-snug font-medium">{str(f.title)}</h3>
            {str(f.text) && <p className="mt-2 leading-relaxed">{str(f.text)}</p>}
          </article>
        ))}
      </div>
    </Section>
  );
}

function Proof({ props: p }: { props: Block["props"] }) {
  const quotes = items(p.items);
  return (
    <section className="px-3 py-10 sm:px-6">
      <div className="mx-auto max-w-[79rem] rounded-[2rem] bg-ink px-6 py-12 text-ink-fg sm:px-10 sm:py-14">
        <div className="grid items-end gap-8 lg:grid-cols-[1fr_auto]">
          <div>
            {str(p.rating) && (
              <p className="mb-5 flex items-center gap-3">
                <span className="font-display text-5xl !text-white">{str(p.rating)}</span>
                <span aria-hidden className="text-xl tracking-widest text-accent">★★★★★</span>
              </p>
            )}
            <h2 className="font-display max-w-2xl text-4xl leading-[1.1] text-balance !text-white">{str(p.title)}</h2>
          </div>
          <div className="flex flex-col items-start gap-3 lg:items-end">
            {str(p.label) && (
              <a href={safeHref(p.href)} className="inline-flex h-12 items-center gap-2 rounded-theme bg-white px-5 text-ink transition hover:bg-white/90">
                {str(p.label)} <span aria-hidden>→</span>
              </a>
            )}
            {str(p.note) && <p className="text-sm text-ink-muted">{str(p.note)}</p>}
          </div>
        </div>
        {quotes.length > 0 && (
          <div className="mt-12 grid gap-5 md:grid-cols-3">
            {quotes.map((q, i) => (
              <figure key={i} className="flex flex-col rounded-panel bg-ink-raised p-7">
                {str(q.headline) && <p className="font-display mb-3 text-2xl !text-white">{str(q.headline)}</p>}
                <blockquote className="flex-1 leading-relaxed">{str(q.quote)}</blockquote>
                <figcaption className="mt-6 text-sm">
                  <span className="text-white">{str(q.author)}</span>
                  {str(q.role) && <span className="text-ink-muted"> · {str(q.role)}</span>}
                </figcaption>
              </figure>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

function Stats({ props: p }: { props: Block["props"] }) {
  const list = items(p.items);
  if (!list.length) return null;
  return (
    <section className="px-4 py-14">
      <dl className="mx-auto grid max-w-6xl grid-cols-2 gap-10 text-center md:flex md:justify-around">
        {list.map((s, i) => (
          <div key={i}>
            <dd className="font-display text-5xl">{str(s.value)}</dd>
            <dt className="mt-2 font-normal text-body">{str(s.label)}</dt>
          </div>
        ))}
      </dl>
    </section>
  );
}

function Testimonials({ props: p }: { props: Block["props"] }) {
  const list = items(p.items);
  if (!list.length) return null;
  return (
    <Section>
      <Heading title={str(p.title)} />
      <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
        {list.map((q, i) => (
          <figure key={i} className="rounded-card border border-border bg-surface p-7">
            <blockquote className="text-sm leading-relaxed">“{str(q.quote)}”</blockquote>
            <figcaption className="mt-4 text-sm">
              <span className="font-semibold">{str(q.author)}</span>
              {str(q.role) && <span className="text-muted"> · {str(q.role)}</span>}
            </figcaption>
          </figure>
        ))}
      </div>
    </Section>
  );
}

function Faq({ props: p }: { props: Block["props"] }) {
  const list = items(p.items);
  if (!list.length) return null;
  return (
    <Section>
      <Heading title={str(p.title)} />
      <div className="mx-auto max-w-3xl divide-y divide-border rounded-card border border-border bg-surface">
        {list.map((f, i) => (
          <details key={i} className="group px-6 py-4">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-4 font-medium">
              {str(f.q)}
              <span aria-hidden className="text-muted transition group-open:rotate-45">+</span>
            </summary>
            <p className="mt-3 text-sm leading-relaxed text-muted">{str(f.a)}</p>
          </details>
        ))}
      </div>
    </Section>
  );
}

function Comparison({ props: p }: { props: Block["props"] }) {
  const columns = str(p.columns).split(",").map((c) => c.trim()).filter(Boolean).slice(0, 6);
  const rows = items(p.rows);
  if (!columns.length || !rows.length) return null;
  const cell = (v: string) => (/^(yes|si|sì|✓)$/i.test(v) ? <span className="text-success">✓</span> : /^(no|—|-)$/i.test(v) ? <span className="text-muted">—</span> : v);
  return (
    <Section>
      <Heading title={str(p.title)} />
      <div className="overflow-x-auto rounded-card border border-border bg-surface">
        <table className="w-full min-w-[36rem] text-sm">
          <thead>
            <tr className="border-b border-border text-left">
              <th className="px-5 py-4 font-medium" />
              {columns.map((c) => <th key={c} className="px-5 py-4 text-center font-medium">{c}</th>)}
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.map((r, i) => {
              const values = str(r.values).split(",").map((v) => v.trim());
              return (
                <tr key={i}>
                  <td className="px-5 py-3.5 text-body">{str(r.feature)}</td>
                  {columns.map((c, n) => <td key={c} className="px-5 py-3.5 text-center">{cell(values[n] ?? "")}</td>)}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Section>
  );
}

async function PriceCalculator({ props: p }: { props: Block["props"] }) {
  const t = await getT();
  const num = (v: unknown) => Math.max(0, Number(str(v).replace(",", ".")) || 0);
  const options = items(p.items).map((o) => ({ label: str(o.label), unitPrice: num(o.unitPrice), max: Math.min(1000, Math.max(1, Math.round(num(o.max)) || 10)) })).filter((o) => o.label);
  if (!options.length) return null;
  // The shared guard: a block must never turn into a javascript: link.
  const href = safeHref(str(p.ctaHref));
  return (
    <Section>
      <Heading title={str(p.title)} />
      <Calculator base={num(p.base)} currency={str(p.currency).slice(0, 3) || "€"} options={options} perMonth={t("per month")} cta={str(p.ctaLabel) && href !== "#" ? { label: str(p.ctaLabel), href } : undefined} />
    </Section>
  );
}

function Cta({ props: p }: { props: Block["props"] }) {
  const strip = p.style === "strip";
  const buttons = (
    <div className={cn("flex flex-wrap gap-3", !strip && "mt-9 justify-center")}>
      {str(p.label) && (
        <a href={safeHref(p.href)} className={cn("inline-flex h-12 items-center gap-2 rounded-theme px-5 transition", strip ? "bg-primary text-primary-fg hover:opacity-85" : "bg-white text-ink hover:bg-white/90")}>
          {str(p.label)} <span aria-hidden>→</span>
        </a>
      )}
      {str(p.secondaryLabel) && (
        <a href={safeHref(p.secondaryHref)} className={cn("inline-flex h-12 items-center rounded-theme border px-5 transition", strip ? "border-fg/80 text-fg hover:bg-fg/5" : "border-white/40 text-white hover:bg-white/10")}>
          {str(p.secondaryLabel)}
        </a>
      )}
    </div>
  );
  if (strip) {
    return (
      <section className="px-3 py-10 sm:px-6">
        <div className="mx-auto grid max-w-[79rem] items-center gap-6 rounded-card bg-subtle p-8 sm:p-10 lg:grid-cols-[1fr_auto]">
          <div>
            <h3 className="font-display text-3xl leading-tight">{str(p.title)}</h3>
            {str(p.text) && <p className="mt-2">{str(p.text)}</p>}
          </div>
          {buttons}
        </div>
      </section>
    );
  }
  return (
    <section className="px-3 py-10 sm:px-6">
      <div className="mx-auto max-w-[79rem] rounded-[2rem] bg-ink px-8 py-20 text-center text-ink-fg">
        <h2 className="font-display mx-auto max-w-3xl text-4xl leading-[1.1] text-balance !text-white sm:text-5xl">{str(p.title)}</h2>
        {str(p.text) && <p className="mx-auto mt-5 max-w-xl text-lg">{str(p.text)}</p>}
        {buttons}
      </div>
    </section>
  );
}

export function RenderBlocks({ blocks }: { blocks: Block[] }) {
  return blocks.map((b) => {
    switch (b.type) {
      case "hero":
        return <Hero key={b.id} props={b.props} />;
      case "pricing":
        return <Pricing key={b.id} props={b.props} />;
      case "proof":
        return <Proof key={b.id} props={b.props} />;
      case "services":
        return <Services key={b.id} props={b.props} />;
      case "split":
        return <Split key={b.id} props={b.props} />;
      case "logos":
        return <Logos key={b.id} props={b.props} />;
      case "features":
        return <Features key={b.id} props={b.props} />;
      case "stats":
        return <Stats key={b.id} props={b.props} />;
      case "testimonials":
        return <Testimonials key={b.id} props={b.props} />;
      case "faq":
        return <Faq key={b.id} props={b.props} />;
      case "comparison":
        return <Comparison key={b.id} props={b.props} />;
      case "calculator":
        return <PriceCalculator key={b.id} props={b.props} />;
      case "cta":
        return <Cta key={b.id} props={b.props} />;
      case "richtext":
        return (
          <Section key={b.id}>
            <div className="mx-auto max-w-3xl">
              <Markdown source={str(b.props.content)} />
            </div>
          </Section>
        );
      default:
        return null;
    }
  });
}
