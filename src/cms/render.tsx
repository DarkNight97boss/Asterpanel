import "server-only";
import { and, asc, eq } from "drizzle-orm";
import { ButtonLink, cn } from "@/components/ui";
import { getDb, schema } from "@/db";
import { getLocale, getT } from "@/i18n";
import { CYCLE_SUFFIX, formatMoney, headlineCycle } from "@/lib/format";
import { getSettings } from "@/lib/settings";
import { items, safeHref, str, type Block } from "./blocks";
import { Markdown } from "./markdown";

const Section = ({ id, className, children }: { id?: string; className?: string; children: React.ReactNode }) => (
  <section id={id} className={cn("px-4 py-16 sm:py-20", className)}>
    <div className="mx-auto max-w-6xl">{children}</div>
  </section>
);

function Heading({ title, subtitle }: { title: string; subtitle?: string }) {
  if (!title && !subtitle) return null;
  return (
    <div className="mx-auto mb-12 max-w-2xl text-center">
      {title && <h2 className="text-3xl font-bold tracking-tight sm:text-4xl">{title}</h2>}
      {subtitle && <p className="mt-3 text-lg text-muted">{subtitle}</p>}
    </div>
  );
}

function Hero({ props: p }: { props: Block["props"] }) {
  const left = p.align === "left";
  return (
    <section className="relative overflow-hidden px-4 py-24 sm:py-32">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-10 opacity-60"
        style={{
          background:
            "radial-gradient(60% 50% at 50% 0%, color-mix(in srgb, var(--primary) 22%, transparent), transparent 70%), radial-gradient(40% 40% at 85% 20%, color-mix(in srgb, var(--accent) 18%, transparent), transparent 70%)",
        }}
      />
      <div className={cn("mx-auto max-w-4xl", !left && "text-center")}>
        {str(p.eyebrow) && (
          <p className="mb-4 inline-block rounded-full border border-border bg-surface px-3 py-1 text-xs font-medium text-muted">
            {str(p.eyebrow)}
          </p>
        )}
        <h1 className="text-4xl font-extrabold tracking-tight text-balance sm:text-6xl">{str(p.title)}</h1>
        {str(p.subtitle) && <p className={cn("mt-6 max-w-2xl text-lg text-muted sm:text-xl", !left && "mx-auto")}>{str(p.subtitle)}</p>}
        <div className={cn("mt-9 flex flex-wrap gap-3", !left && "justify-center")}>
          {str(p.primaryLabel) && (
            <ButtonLink href={safeHref(p.primaryHref)} size="lg">
              {str(p.primaryLabel)}
            </ButtonLink>
          )}
          {str(p.secondaryLabel) && (
            <ButtonLink href={safeHref(p.secondaryHref)} size="lg" variant="secondary">
              {str(p.secondaryLabel)}
            </ButtonLink>
          )}
        </div>
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
    <Section id="pricing" className="bg-subtle">
      <Heading title={str(p.title)} subtitle={str(p.subtitle)} />
      <div className={cn("mx-auto grid gap-6", plans.length >= 3 ? "lg:grid-cols-3" : "max-w-3xl sm:grid-cols-2", plans.length === 1 && "max-w-sm sm:grid-cols-1")}>
        {plans.map((plan) => {
          const cycle = headlineCycle(plan.pricing);
          return (
            <div
              key={plan.id}
              className={cn(
                "relative flex flex-col rounded-theme border bg-surface p-7",
                plan.featured ? "border-primary shadow-lg ring-1 ring-primary" : "border-border",
              )}
            >
              {plan.featured && (
                <span className="absolute -top-3 left-7 rounded-full bg-primary px-3 py-0.5 text-xs font-semibold text-primary-fg">
                  {t("Most popular")}
                </span>
              )}
              <h3 className="text-lg font-semibold">{plan.name}</h3>
              {plan.tagline && <p className="mt-1 text-sm text-muted">{plan.tagline}</p>}
              {cycle && (
                <p className="mt-6 flex items-baseline gap-1">
                  <span className="text-4xl font-extrabold tracking-tight">{formatMoney(plan.pricing[cycle]!, billing.currency, locale)}</span>
                  <span className="text-sm text-muted">{t(CYCLE_SUFFIX[cycle])}</span>
                </p>
              )}
              <ul className="mt-6 mb-8 flex-1 space-y-2.5 text-sm">
                {plan.features.map((f, i) => (
                  <li key={i} className="flex gap-2.5">
                    <span aria-hidden className="font-bold text-primary">✓</span>
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

function Features({ props: p }: { props: Block["props"] }) {
  return (
    <Section>
      <Heading title={str(p.title)} subtitle={str(p.subtitle)} />
      <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
        {items(p.items).map((f, i) => (
          <div key={i} className="rounded-theme border border-border bg-surface p-6">
            {str(f.icon) && <div className="mb-4 grid size-11 place-items-center rounded-theme bg-primary/10 text-xl">{str(f.icon)}</div>}
            <h3 className="font-semibold">{str(f.title)}</h3>
            <p className="mt-1.5 text-sm leading-relaxed text-muted">{str(f.text)}</p>
          </div>
        ))}
      </div>
    </Section>
  );
}

function Stats({ props: p }: { props: Block["props"] }) {
  const list = items(p.items);
  if (!list.length) return null;
  return (
    <section className="border-y border-border px-4 py-10">
      <dl className="mx-auto grid max-w-5xl grid-cols-2 gap-8 text-center sm:flex sm:justify-around">
        {list.map((s, i) => (
          <div key={i}>
            <dd className="text-3xl font-extrabold tracking-tight text-primary">{str(s.value)}</dd>
            <dt className="mt-1 text-sm text-muted">{str(s.label)}</dt>
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
    <Section className="bg-subtle">
      <Heading title={str(p.title)} />
      <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
        {list.map((q, i) => (
          <figure key={i} className="rounded-theme border border-border bg-surface p-6">
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
      <div className="mx-auto max-w-3xl divide-y divide-border rounded-theme border border-border bg-surface">
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

function Cta({ props: p }: { props: Block["props"] }) {
  return (
    <Section>
      <div className="rounded-theme bg-primary px-8 py-14 text-center text-primary-fg">
        <h2 className="text-3xl font-bold tracking-tight">{str(p.title)}</h2>
        {str(p.text) && <p className="mx-auto mt-3 max-w-xl opacity-90">{str(p.text)}</p>}
        {str(p.label) && (
          <ButtonLink href={safeHref(p.href)} size="lg" variant="secondary" className="mt-8">
            {str(p.label)}
          </ButtonLink>
        )}
      </div>
    </Section>
  );
}

export function RenderBlocks({ blocks }: { blocks: Block[] }) {
  return blocks.map((b) => {
    switch (b.type) {
      case "hero":
        return <Hero key={b.id} props={b.props} />;
      case "pricing":
        return <Pricing key={b.id} props={b.props} />;
      case "features":
        return <Features key={b.id} props={b.props} />;
      case "stats":
        return <Stats key={b.id} props={b.props} />;
      case "testimonials":
        return <Testimonials key={b.id} props={b.props} />;
      case "faq":
        return <Faq key={b.id} props={b.props} />;
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
