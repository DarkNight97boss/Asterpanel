import Link from "next/link";
import { desc, eq } from "drizzle-orm";
import { Button, ButtonLink, Card, EmptyState, Input, PageHeader, StatusBadge, Table, Td } from "@/components/ui";
import { getDb, schema } from "@/db";
import { getLocale, getT } from "@/i18n";
import { requireAccount } from "@/lib/account";
import { formatDate } from "@/lib/format";

export const metadata = { title: "Domains" };

/** Expiry dates closer than this are highlighted. */
const inDays = (n: number) => new Date(Date.now() + n * 86_400_000);

export default async function Domains() {
  const { account, can } = await requireAccount("hosting");
  const db = await getDb();
  const [t, locale, names, onSale] = await Promise.all([
    getT(),
    getLocale(),
    db.select().from(schema.domainNames).where(eq(schema.domainNames.companyId, account.id)).orderBy(desc(schema.domainNames.createdAt)),
    db.select({ id: schema.domainTlds.id }).from(schema.domainTlds).where(eq(schema.domainTlds.enabled, true)).limit(1),
  ]);
  const soon = inDays(30);

  return (
    <>
      <PageHeader title={t("Domains")} description={t("Register new domain names or transfer the ones you own, and manage them here.")} action={can("manage") && onSale.length > 0 && <ButtonLink href="/client/domains/new">+ {t("Add domain")}</ButtonLink>} />
      {can("manage") && onSale.length > 0 && (
        <Card className="mb-6 p-5">
          <form action="/client/domains/new" className="flex flex-wrap gap-3">
            <Input name="q" required placeholder={t("Find your domain: example.com")} className="min-w-64 flex-1" />
            <Button>{t("Search")}</Button>
          </form>
        </Card>
      )}
      <Card>
        {names.length ? (
          <Table head={[t("Domain"), t("Expires"), t("Name servers"), t("Status")]}>
            {names.map((d) => (
              <tr key={d.id}>
                <Td><Link href={`/client/domains/${d.id}`} className="font-medium text-link">{d.name}</Link></Td>
                <Td className={d.expiresAt && d.expiresAt < soon ? "text-danger" : "text-body"}>{d.expiresAt ? formatDate(d.expiresAt, locale) : "—"}</Td>
                <Td className="text-body">{d.nameservers.slice(0, 2).join(", ") || "—"}</Td>
                <Td><StatusBadge status={d.status === "transferring" ? "creating" : d.status === "failed" ? "error" : d.status} label={t(d.status)} /></Td>
              </tr>
            ))}
          </Table>
        ) : (
          <EmptyState title={t("No domains yet")} description={onSale.length ? t("Search for a name above to get started.") : t("Domain registration is not available yet.")} />
        )}
      </Card>
    </>
  );
}
