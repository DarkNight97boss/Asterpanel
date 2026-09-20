import { notFound } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { Alert, ButtonLink, Card, CardHeader, Checkbox, Field, PageHeader, StatusBadge, STATUS_LABEL, Textarea } from "@/components/ui";
import { getDb, schema } from "@/db";
import { getLocale, getT } from "@/i18n";
import { requireAccount } from "@/lib/account";
import { CYCLE_LABEL, formatDate, formatMoney } from "@/lib/format";
import { planOptions, remainingFraction } from "@/lib/billing";
import { getSettings } from "@/lib/settings";
import { cancelService, switchPlan } from "@/app/client/actions";
import { getProvisioningModule } from "@/modules/provisioning";

export default async function ClientService({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user: me, account: user } = await requireAccount("billing");
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const db = await getDb();
  const service = await db.query.services.findFirst({
    where: and(eq(schema.services.id, id), eq(schema.services.companyId, user.id)),
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

  const options = service.status === "active" ? await planOptions(service.id) : [];
  const fraction = service.nextDueDate ? remainingFraction(service.nextDueDate, service.billingCycle) : 0;
  const money = (c: number) => formatMoney(c, billing.currency, locale);
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

      {options.length > 0 && service.nextDueDate && (
        <Card className="mt-6">
          <CardHeader title={t("Change plan")} description={t("Upgrades start as soon as the pro-rated difference is paid. Downgrades start at once, and the unused part goes to your credit for the next invoices.")} />
          <ul className="divide-y divide-border">
            {options.map((p) => {
              const price = p.pricing[service.billingCycle]!;
              const prorated = Math.round((price - service.amount) * fraction);
              return (
                <li key={p.id} className="flex flex-wrap items-center justify-between gap-4 px-5 py-4 text-sm">
                  <div>
                    <p className="font-medium">{p.name} <span className="ml-2 font-normal text-muted">{money(price)} · {t(CYCLE_LABEL[service.billingCycle])}</span></p>
                    <p className="text-xs text-muted">{prorated > 0 ? t("Pay {amount} now (plus tax) for the rest of this period", { amount: money(prorated) }) : prorated < 0 ? t("{amount} goes to your credit", { amount: money(-prorated) }) : t("No charge for the rest of this period")}</p>
                  </div>
                  <ActionForm action={switchPlan} className="">
                    <input type="hidden" name="serviceId" value={service.id} />
                    <input type="hidden" name="productId" value={p.id} />
                    <SubmitButton size="sm" variant="secondary">{price > service.amount ? t("Upgrade") : t("Switch")}</SubmitButton>
                  </ActionForm>
                </li>
              );
            })}
          </ul>
        </Card>
      )}
      {(service.status === "active" || service.status === "suspended") && (
        <Card className="mt-6">
          {service.cancelAtPeriodEnd ? (
            <>
              <CardHeader title={t("Cancellation requested")} description={t("This service stays on until {date} and is not renewed after that.", { date: formatDate(service.nextDueDate, locale) })} />
              <ActionForm action={cancelService} className="p-5 pt-0">
                <input type="hidden" name="serviceId" value={service.id} />
                <input type="hidden" name="undo" value="1" />
                <SubmitButton variant="secondary">{t("Keep the service")}</SubmitButton>
              </ActionForm>
            </>
          ) : (
            <details>
              <summary className="cursor-pointer px-5 py-4 text-sm font-medium text-body">{t("Cancel this service")}</summary>
              <ActionForm action={cancelService} className="space-y-4 p-5 pt-0">
                <input type="hidden" name="serviceId" value={service.id} />
                <p className="text-sm text-muted">{t("The service keeps working until {date}, the end of what you have already paid, and is not renewed. You can change your mind until then.", { date: formatDate(service.nextDueDate, locale) })}</p>
                <Field label={t("Why are you leaving? (optional)")}><Textarea name="reason" rows={3} maxLength={1000} /></Field>
                <Checkbox name="confirm" label={t("I want to cancel this service at the end of the period")} />
                <SubmitButton variant="danger">{t("Request cancellation")}</SubmitButton>
              </ActionForm>
            </details>
          )}
        </Card>
      )}
    </>
  );
}
