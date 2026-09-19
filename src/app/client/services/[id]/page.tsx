import { notFound } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { Alert, ButtonLink, Card, PageHeader, StatusBadge, STATUS_LABEL } from "@/components/ui";
import { getDb, schema } from "@/db";
import { getLocale, getT } from "@/i18n";
import { requireAccount } from "@/lib/account";
import { CYCLE_LABEL, formatDate, formatMoney } from "@/lib/format";
import { getSettings } from "@/lib/settings";
import { getProvisioningModule } from "@/modules/provisioning";

export default async function ClientService({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user: me, account: user } = await requireAccount("billing");
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const db = await getDb();
  const service = await db.query.services.findFirst({
    where: and(eq(schema.services.id, id), eq(schema.services.clientId, user.id)),
    with: { product: true, server: true },
  });
  if (!service) notFound();

  const [t, locale, billing] = await Promise.all([getT(), getLocale(), getSettings("billing")]);
  const { product, server, ...row } = service;
  const panelUrl =
    service.status === "active" && server
      ? getProvisioningModule(product.module).loginUrl?.({
          service: row,
          product,
          client: me,
          server: { id: server.id, name: server.name, hostname: server.hostname, credentials: {} },
        })
      : null;

  const rows: [string, React.ReactNode][] = [
    [t("Status"), <StatusBadge key="s" status={service.status} label={t(STATUS_LABEL[service.status])} />],
    [t("Domain"), service.domain || "—"],
    [t("Username"), service.username || "—"],
    [t("Price"), `${formatMoney(service.amount, billing.currency, locale)} · ${t(CYCLE_LABEL[service.billingCycle])}`],
    [t("Next due"), formatDate(service.nextDueDate, locale)],
    [t("Created"), formatDate(service.createdAt, locale)],
  ];

  return (
    <>
      <PageHeader
        title={product.name}
        description={service.domain}
        action={panelUrl ? <ButtonLink href={panelUrl} target="_blank" rel="noopener noreferrer">{t("Open control panel")} ↗</ButtonLink> : undefined}
      />
      {service.status === "pending" && <div className="mb-4"><Alert tone="warning">{t("This service will be activated as soon as its invoice is paid.")}</Alert></div>}
      {service.status === "suspended" && <div className="mb-4"><Alert tone="danger">{t("This service is suspended.")} {t(service.suspendReason)}</Alert></div>}
      <Card>
        <dl className="divide-y divide-border text-sm">
          {rows.map(([label, value]) => (
            <div key={label} className="grid grid-cols-3 gap-4 px-5 py-3.5">
              <dt className="text-muted">{label}</dt>
              <dd className="col-span-2">{value}</dd>
            </div>
          ))}
        </dl>
      </Card>
    </>
  );
}
