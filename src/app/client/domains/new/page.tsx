import { Alert, Button, ButtonLink, Card, Input, PageHeader, Table, Td } from "@/components/ui";
import { getLocale, getT } from "@/i18n";
import { requireAccount } from "@/lib/account";
import { DomainError, searchDomains, type SearchHit } from "@/lib/domains";
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
  if (q) {
    // Every search costs API calls at the registrar.
    if (!rateLimit(`domain-search:${account.id}`, 40, 10 * 60_000)) error = "Too many attempts. Try again in a few minutes.";
    else
      try {
        hits = await searchDomains(q);
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
      {hits.length > 0 && (
        <Card>
          <Table head={[t("Domain"), t("Availability"), t("First year"), t("Renewal"), ""]}>
            {hits.map((h) => (
              <tr key={h.domain}>
                <Td className="font-medium">{h.domain}</Td>
                <Td>{h.available === null ? <span className="text-muted">{t("Could not check")}</span> : h.available ? <span className="text-success">● {t("Available")}</span> : <span className="text-muted">{t("Already registered")}</span>}</Td>
                <Td>{money(h.available === false ? h.transferPrice : h.registerPrice)}{h.available !== false && h.listPrice && <span className="ml-2 text-xs text-muted line-through">{money(h.listPrice)}</span>}</Td>
                <Td className="text-body">{money(h.renewPrice)} / {t("year")}</Td>
                <Td className="text-right">
                  {h.available ? <ButtonLink href={link(h, "register")} size="sm">{t("Register")}</ButtonLink> : h.available === false ? <ButtonLink href={link(h, "transfer")} size="sm" variant="secondary">{t("Transfer")}</ButtonLink> : null}
                </Td>
              </tr>
            ))}
          </Table>
        </Card>
      )}
    </>
  );
}
