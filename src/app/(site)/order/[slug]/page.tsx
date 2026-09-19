import { notFound, redirect } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { ButtonLink, Card, Field, Input } from "@/components/ui";
import { getDb, schema } from "@/db";
import { getLocale, getT } from "@/i18n";
import { getUser } from "@/lib/auth";
import { CYCLE_LABEL, enabledCycles, formatMoney } from "@/lib/format";
import { getSettings } from "@/lib/settings";
import { planType } from "@/modules/provisioning/platform";
import { WORKLOAD_LABEL } from "@/platform/ui";
import { submitOrder } from "../actions";

export const metadata = { title: "Order" };

export default async function OrderPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const db = await getDb();
  const product = await db.query.products.findFirst({
    where: and(eq(schema.products.slug, slug), eq(schema.products.hidden, false)),
  });
  if (!product) notFound();
  // Platform plans are configured in the dashboard wizard, not here.
  if (product.module === "platform") redirect(`${WORKLOAD_LABEL[planType(product.moduleConfig)].path.replace("/client/", "/client/new/")}?plan=${product.slug}`);

  const [user, t, locale, billing] = await Promise.all([getUser(), getT(), getLocale(), getSettings("billing")]);
  const cycles = enabledCycles(product.pricing);
  const setup = product.pricing.setup ?? 0;
  const here = `/order/${product.slug}`;

  return (
    <div className="mx-auto grid max-w-5xl gap-8 px-4 py-14 lg:grid-cols-[1fr_22rem]">
      <div>
        <h1 className="text-3xl tracking-tight">{product.name}</h1>
        {product.tagline && <p className="mt-2 text-lg text-muted">{product.tagline}</p>}
        {product.description && <p className="mt-5 leading-relaxed whitespace-pre-line">{product.description}</p>}
        <ul className="mt-6 grid gap-2.5 text-sm sm:grid-cols-2">
          {product.features.map((f, i) => (
            <li key={i} className="flex gap-2.5">
              <span aria-hidden className="font-bold text-link">✓</span>
              {f}
            </li>
          ))}
        </ul>
      </div>

      <Card className="h-fit p-6">
        <h2 className="mb-4 font-semibold">{t("Configure")}</h2>
        {!cycles.length ? (
          <p className="text-sm text-muted">{t("This product is not available for order right now.")}</p>
        ) : !user ? (
          <div className="space-y-3">
            <p className="text-sm text-muted">{t("Sign in or create an account to continue.")}</p>
            <ButtonLink href={`/login?next=${encodeURIComponent(here)}`} className="w-full">
              {t("Sign in")}
            </ButtonLink>
            <ButtonLink href={`/register?next=${encodeURIComponent(here)}`} variant="secondary" className="w-full">
              {t("Create an account")}
            </ButtonLink>
          </div>
        ) : (
          <ActionForm action={submitOrder}>
            <input type="hidden" name="productId" value={product.id} />
            <fieldset className="space-y-2">
              <legend className="mb-1.5 text-sm font-medium">{t("Billing cycle")}</legend>
              {cycles.map((c, i) => (
                <label key={c} className="flex cursor-pointer items-center justify-between gap-3 rounded-theme border border-border px-3 py-2.5 text-sm has-checked:border-accent has-checked:bg-accent/5">
                  <span className="flex items-center gap-2.5">
                    <input type="radio" name="cycle" value={c} defaultChecked={i === 0} className="accent-(--accent)" required />
                    {t(CYCLE_LABEL[c])}
                  </span>
                  <span className="font-semibold">{formatMoney(product.pricing[c]!, billing.currency, locale)}</span>
                </label>
              ))}
            </fieldset>
            {product.requiresDomain && (
              <Field label={t("Domain")}>
                <Input name="domain" placeholder="example.com" required autoCapitalize="none" spellCheck={false} />
              </Field>
            )}
            {setup > 0 && (
              <p className="flex justify-between text-sm text-muted">
                <span>{t("Setup fee")}</span>
                <span>{formatMoney(setup, billing.currency, locale)}</span>
              </p>
            )}
            {billing.taxRate > 0 && (
              <p className="text-xs text-muted">{t("Prices exclude {tax} ({rate}%).", { tax: billing.taxName, rate: billing.taxRate / 100 })}</p>
            )}
            <Field label={t("Discount code")}><Input name="coupon" maxLength={40} autoComplete="off" className="uppercase" /></Field>
            <SubmitButton className="w-full">{t("Place order")}</SubmitButton>
          </ActionForm>
        )}
      </Card>
    </div>
  );
}
