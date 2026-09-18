import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { Button, Card, CardHeader, Checkbox, Field, Input, PageHeader, Select } from "@/components/ui";
import { getDb, schema } from "@/db";
import { getT } from "@/i18n";
import { requireAdmin } from "@/lib/auth";
import { decryptJson } from "@/lib/crypto";
import { provisioningModules } from "@/modules/provisioning";
import { deleteServer, saveServer, testServer } from "../../actions";

export default async function ServerEditor({ params }: { params: Promise<{ id: string }> }) {
  await requireAdmin();
  const { id } = await params;
  const isNew = id === "new";
  if (!isNew && !/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const db = await getDb();
  const [server, t] = await Promise.all([isNew ? undefined : db.query.servers.findFirst({ where: eq(schema.servers.id, id) }), getT()]);
  if (!isNew && !server) notFound();

  const modules = provisioningModules.filter((m) => m.requiresServer);
  const credentials = decryptJson<Record<string, string>>(server?.credentials ?? "", {});

  return (
    <>
      <PageHeader title={server?.name ?? t("New server")} />
      <Card className="max-w-2xl">
        <CardHeader title={t("Connection")} description={t("Credentials are encrypted at rest and never shown again.")} />
        <div className="p-5">
          <ActionForm action={saveServer}>
            <input type="hidden" name="id" value={server?.id ?? ""} />
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={t("Name")}><Input name="name" defaultValue={server?.name} required /></Field>
              <Field label={t("Module")}>
                <Select name="module" defaultValue={server?.module ?? modules[0]?.id}>
                  {modules.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                </Select>
              </Field>
              <Field label={t("Hostname")}><Input name="hostname" defaultValue={server?.hostname} placeholder="server1.example.com" required /></Field>
              <Field label={t("Max accounts")} hint={t("0 = unlimited")}><Input name="maxAccounts" type="number" min={0} defaultValue={server?.maxAccounts ?? 0} /></Field>
              {modules.flatMap((m) =>
                m.serverFields.map((f) => (
                  <Field key={`${m.id}.${f.name}`} label={`${m.name}: ${f.label}`} hint={f.help}>
                    <Input
                      name={`cred_${f.name}`}
                      type={f.type === "password" ? "password" : "text"}
                      autoComplete="off"
                      placeholder={f.type === "password" && credentials[f.name] ? "••••••••  (unchanged)" : f.placeholder}
                      defaultValue={f.type === "password" ? "" : credentials[f.name]}
                    />
                  </Field>
                )),
              )}
            </div>
            <Checkbox name="active" defaultChecked={server?.active ?? true} label={t("Active")} />
            <SubmitButton>{t("Save")}</SubmitButton>
          </ActionForm>
        </div>
      </Card>

      {server && (
        <div className="mt-6 flex max-w-2xl flex-wrap items-start gap-3">
          <ActionForm action={testServer} className="flex-1">
            <input type="hidden" name="id" value={server.id} />
            <SubmitButton variant="secondary">{t("Test connection")}</SubmitButton>
          </ActionForm>
          <form action={deleteServer}>
            <input type="hidden" name="id" value={server.id} />
            <Button variant="ghost">{t("Delete server")}</Button>
          </form>
        </div>
      )}
    </>
  );
}
