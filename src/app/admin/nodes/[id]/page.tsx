import Link from "next/link";
import { notFound } from "next/navigation";
import { and, desc, eq, ne } from "drizzle-orm";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { Card, CardHeader, Checkbox, EmptyState, Field, Input, PageHeader, StatusBadge, Table, Td } from "@/components/ui";
import { getDb, schema } from "@/db";
import { getT } from "@/i18n";
import { requireAdmin } from "@/lib/auth";
import { deleteNode, rotateNodeToken, saveNode } from "../../platform-actions";

export default async function NodeDetail({ params }: { params: Promise<{ id: string }> }) {
  await requireAdmin();
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const db = await getDb();
  const [[node], workloads, t] = await Promise.all([
    db.select().from(schema.nodes).where(eq(schema.nodes.id, id)),
    db.select().from(schema.workloads).where(and(eq(schema.workloads.nodeId, id), ne(schema.workloads.status, "deleted"))).orderBy(desc(schema.workloads.createdAt)),
    getT(),
  ]);
  if (!node) notFound();

  return (
    <>
      <PageHeader title={node.name} description={`*.${node.baseDomain || "—"} · ${node.publicIp || "—"}`} action={<Link href="/admin/nodes" className="text-sm text-link">← {t("Nodes")}</Link>} />
      <div className="grid items-start gap-6 xl:grid-cols-2">
        <Card>
          <CardHeader title={t("Settings")} />
          <div className="p-5">
            <ActionForm action={saveNode}>
              <input type="hidden" name="id" value={node.id} />
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label={t("Name")}><Input name="name" defaultValue={node.name} required /></Field>
                <Field label={t("Region")}><Input name="region" defaultValue={node.region} /></Field>
                <Field label={t("Base domain")}><Input name="baseDomain" defaultValue={node.baseDomain} /></Field>
                <Field label={t("Public IP")}><Input name="publicIp" defaultValue={node.publicIp} /></Field>
                <Field label={t("Max workloads")} hint={t("0 = unlimited")}><Input name="maxWorkloads" type="number" min={0} defaultValue={node.maxWorkloads} /></Field>
              </div>
              <Checkbox name="disabled" defaultChecked={node.status === "disabled"} label={t("Disabled: no new workloads, agent rejected")} />
              <SubmitButton>{t("Save")}</SubmitButton>
            </ActionForm>
          </div>
        </Card>
        <Card>
          <CardHeader title={t("Agent credentials")} description={t("Generates a new token and shows the install command. The old token stops working immediately.")} />
          <div className="space-y-4 p-5">
            <ActionForm action={rotateNodeToken}>
              <input type="hidden" name="id" value={node.id} />
              <SubmitButton variant="secondary" confirm={t("Generate a new token? The running agent will be disconnected.")}>{t("New token & install command")}</SubmitButton>
            </ActionForm>
            <ActionForm action={deleteNode}>
              <input type="hidden" name="id" value={node.id} />
              <SubmitButton variant="ghost" confirm={t("Delete this node?")}>{t("Delete node")}</SubmitButton>
            </ActionForm>
          </div>
        </Card>
      </div>
      <Card className="mt-6">
        <CardHeader title={t("Workloads on this node")} />
        {workloads.length ? (
          <Table head={[t("Name"), t("Type"), t("Status")]}>
            {workloads.map((w) => (
              <tr key={w.id}>
                <Td><Link href={`/client/workloads/${w.id}`} className="font-medium hover:text-link">{w.name}</Link><span className="block font-mono text-xs text-muted">{w.slug}</span></Td>
                <Td className="capitalize">{w.type}</Td>
                <Td><StatusBadge status={w.status} /></Td>
              </tr>
            ))}
          </Table>
        ) : (
          <EmptyState title={t("Nothing here yet")} />
        )}
      </Card>
    </>
  );
}
