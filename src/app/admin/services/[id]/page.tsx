import Link from "next/link";
import { notFound } from "next/navigation";
import { asc, eq } from "drizzle-orm";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { Card, CardHeader, Field, Input, PageHeader, Select, StatusBadge, STATUS_LABEL } from "@/components/ui";
import { getDb, schema } from "@/db";
import { BILLING_CYCLES } from "@/db/schema";
import { getT } from "@/i18n";
import { displayName, requireArea } from "@/lib/auth";
import { centsToInput, CYCLE_LABEL } from "@/lib/format";
import { getProvisioningModule } from "@/modules/provisioning";
import { saveService, serviceCommand } from "../../actions";

export default async function ServiceDetail({ params }: { params: Promise<{ id: string }> }) {
  await requireArea("billing");
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const db = await getDb();
  const [service, servers, t] = await Promise.all([
    db.query.services.findFirst({ where: eq(schema.services.id, id), with: { product: true, client: { columns: { passwordHash: false } } } }),
    db.select({ id: schema.servers.id, name: schema.servers.name }).from(schema.servers).orderBy(asc(schema.servers.name)),
    getT(),
  ]);
  if (!service) notFound();
  const mod = getProvisioningModule(service.product.module);

  const commands = (
    {
      pending: [["activate", t("Activate"), "primary"]],
      active: [["suspend", t("Suspend"), "secondary"], ["terminate", t("Terminate"), "danger"]],
      suspended: [["unsuspend", t("Unsuspend"), "primary"], ["terminate", t("Terminate"), "danger"]],
      terminated: [],
      cancelled: [],
    } as const
  )[service.status];

  return (
    <>
      <PageHeader
        title={service.product.name}
        description={
          <>
            <StatusBadge status={service.status} label={t(STATUS_LABEL[service.status])} />{" "}
            <Link href={`/admin/clients/${service.clientId}`} className="hover:text-link">{displayName(service.client)}</Link>
            {service.suspendReason && <> · {service.suspendReason}</>}
          </>
        }
      />
      <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
        <Card>
          <CardHeader title={t("Details")} />
          <div className="p-5">
            <ActionForm action={saveService}>
              <input type="hidden" name="id" value={service.id} />
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label={t("Domain")}><Input name="domain" defaultValue={service.domain} /></Field>
                <Field label={t("Username")}><Input name="username" defaultValue={service.username} /></Field>
                <Field label={t("Billing cycle")}>
                  <Select name="billingCycle" defaultValue={service.billingCycle}>
                    {BILLING_CYCLES.map((c) => <option key={c} value={c}>{t(CYCLE_LABEL[c])}</option>)}
                  </Select>
                </Field>
                <Field label={t("Recurring amount")}><Input name="amount" inputMode="decimal" defaultValue={centsToInput(service.amount)} required /></Field>
                <Field label={t("Next due")}><Input name="nextDueDate" type="date" defaultValue={service.nextDueDate?.toISOString().slice(0, 10) ?? ""} /></Field>
                <Field label={t("Server")}>
                  <Select name="serverId" defaultValue={service.serverId ?? ""}>
                    <option value="">—</option>
                    {servers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </Select>
                </Field>
              </div>
              <SubmitButton>{t("Save")}</SubmitButton>
            </ActionForm>
          </div>
        </Card>

        <Card className="h-fit">
          <CardHeader title={t("Module commands")} description={mod.name} />
          <div className="space-y-3 p-5">
            {commands.length === 0 && <p className="text-sm text-muted">{t("No commands available in this state.")}</p>}
            {commands.map(([command, label, variant]) => (
              <ActionForm key={command} action={serviceCommand}>
                <input type="hidden" name="id" value={service.id} />
                <input type="hidden" name="command" value={command} />
                {command === "suspend" && <Input name="reason" placeholder={t("Reason (optional)")} />}
                <SubmitButton variant={variant} className="w-full" confirm={command === "terminate" ? t("Terminate this service? The hosting account will be deleted.") : undefined}>
                  {label}
                </SubmitButton>
              </ActionForm>
            ))}
          </div>
        </Card>
      </div>
    </>
  );
}
