import Link from "next/link";
import { addTickedToCart } from "../actions";
import { Alert, Button, ButtonLink, Card, CardHeader, Input, PageHeader, Table, Td } from "@/components/ui";
import { getLocale, getT } from "@/i18n";
import { requireAccount } from "@/lib/account";
import { DomainError, searchDomains, suggestDomains, type SearchHit } from "@/lib/domains";
import { formatMoney } from "@/lib/format";
import { rateLimit } from "@/lib/rate-limit";
import { getSettings } from "@/lib/settings";

export const metadata = { title: "Add domain" };

export default async function NewDomain({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const { account } = await requireAccount("manage");
  const q = ((await searchParams).q ?? "").trim().slice(0, 80);
  const [t, locale, billing] = await Promise.all([getT(), getLocale(), getSettings("billing")]);
  let hits: SearchHit[] = [];
  let error = "";
  let suggestions: SearchHit[] = [];
  if (q) {
    // Every search costs API calls at the registrar.
    if (!rateLimit(`domain-search:${account.id}`, 40, 10 * 60_000)) error = "Too many attempts. Try again in a few minutes.";
    else
      try {
        hits = await searchDomains(q);
        // Only when the name asked for is gone: otherwise suggestions are noise.
        if (hits[0]?.available === false) suggestions = await suggestDomains(q);
      } catch (err) {
        if (!(err instanceof DomainError)) throw err;
        error = err.message;
      }
  }
  const money = (c: number) => formatMoney(c, billing.currency, locale);
  const link = (h: SearchHit, action: string) => `/client/domains/order?domain=${encodeURIComponent(h.domain)}&action=${action}`;

  return (
    <>
      <PageHeader title={t("Add domain")} description={t("Search a new name, or type a domain you already own to transfer it here.")} />
      <Card className="mb-6 p-5">
        <form className="flex flex-wrap gap-3">
          <Input name="q" required defaultValue={q} placeholder={t("Find your domain: example.com")} className="min-w-64 flex-1" autoFocus />
          <Button>{t("Search")}</Button>
        </form>
      </Card>
      {error && <Alert tone="danger">{t(error)}</Alert>}
      {!q && <p className="mb-6 text-sm text-muted">{t("Moving several domains?")} <Link href="/client/domains/order?bulk=1" className="font-medium text-accent hover:underline">{t("Bulk transfer")}</Link></p>}
      {suggestions.length > 0 && (
        <Card className="mb-6">
          <CardHeader title={t("Still free")} description={t("Close to what you searched for.")} />
          <ul className="divide-y divide-border border-t border-border">
            {suggestions.map((h) => (
              <li key={h.domain} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3 text-sm">
                <span className="font-medium">{h.domain}</span>
                <span className="flex items-center gap-4"><span className="text-body">{money(h.registerPrice)}</span><ButtonLink href={link(h, "register")} size="sm" variant="secondary">{t("Register")}</ButtonLink></span>
              </li>
            ))}
          </ul>
        </Card>
      )}
      {hits.length > 0 && (
        <Card>
          <form action="/client/domains/order" method="get">
          <Table head={[t("Domain"), t("Availability"), t("First year"), t("Renewal"), ""]}>
            {hits.map((h) => (
              <tr key={h.domain}>
                <Td className="font-medium"><label className="flex items-center gap-2.5">{h.available && <input type="checkbox" name="domain" value={h.domain} className="accent-(--accent)" />}{h.domain}</label></Td>
                <Td>{h.available === null ? <span className="text-muted">{t("Could not check")}</span> : h.available ? <span className="text-success">● {t("Available")}</span> : <span className="text-muted">{t("Already registered")}</span>}</Td>
                <Td>{money(h.available === false ? h.transferPrice : h.registerPrice)}{h.available !== false && h.listPrice && <span className="ml-2 text-xs text-muted line-through">{money(h.listPrice)}</span>}</Td>
                <Td className="text-body">{money(h.renewPrice)} / {t("year")}</Td>
                <Td className="text-right">
                  {h.available ? <ButtonLink href={link(h, "register")} size="sm">{t("Register")}</ButtonLink> : h.available === false ? <ButtonLink href={link(h, "transfer")} size="sm" variant="secondary">{t("Transfer")}</ButtonLink> : null}
                </Td>
              </tr>
            ))}
          </Table>
          {hits.some((h) => h.available) && <div className="flex items-center justify-between gap-3 border-t border-border p-4 text-sm text-muted"><span>{t("Tick several names to register them together, on one invoice.")}</span><span className="flex gap-2"><Button variant="ghost" size="sm" formAction={addTickedToCart} formMethod="post">{t("Add to cart")}</Button><Button variant="secondary" size="sm">{t("Register the ticked ones")}</Button></span></div>}
          </form>
        </Card>
      )}
    </>
  );
}
