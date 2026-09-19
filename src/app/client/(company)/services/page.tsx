import Link from "next/link";
import { desc, eq } from "drizzle-orm";
import { ButtonLink, Card, EmptyState, PageHeader, StatusBadge, Table, Td, STATUS_LABEL } from "@/components/ui";
import { getDb, schema } from "@/db";
import { getLocale, getT } from "@/i18n";
import { requireAccount } from "@/lib/account";
import { CYCLE_LABEL, formatDate, formatMoney } from "@/lib/format";
import { getSettings } from "@/lib/settings";

export default async function ClientServices() {
  const { account: user } = await requireAccount("billing");
  const db = await getDb();
  const [t, locale, billing, services] = await Promise.all([
    getT(),
    getLocale(),
    getSettings("billing"),
    db.query.services.findMany({ where: eq(schema.services.companyId, user.id), with: { product: true }, orderBy: desc(schema.services.createdAt) }),
  ]);

  return (
    <>
      <PageHeader title={t("Services")} action={<ButtonLink href="/#pricing">{t("Order new")}</ButtonLink>} />
      <Card>
        {services.length ? (
          <Table head={[t("Service"), t("Price"), t("Next due"), t("Status")]}>
            {services.map((s) => (
              <tr key={s.id}>
                <Td>
                  <Link href={`/client/services/${s.id}`} className="font-medium hover:text-link">{s.product.name}</Link>
                  {s.domain && <span className="block text-xs text-muted">{s.domain}</span>}
                </Td>
                <Td>
                  {formatMoney(s.amount, billing.currency, locale)} <span className="text-xs text-muted">{t(CYCLE_LABEL[s.billingCycle])}</span>
                </Td>
                <Td>{formatDate(s.nextDueDate, locale)}</Td>
                <Td><StatusBadge status={s.status} label={t(STATUS_LABEL[s.status])} /></Td>
              </tr>
            ))}
          </Table>
        ) : (
          <EmptyState title={t("No services yet")} description={t("Your hosting plans will show up here.")} />
        )}
      </Card>
    </>
  );
}
