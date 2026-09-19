import { ActionForm, SubmitButton } from "@/components/action-form";
import { Badge, Button, Card, CardHeader, Input, Table, Td } from "@/components/ui";
import { getT } from "@/i18n";
import { requireWorkload } from "@/platform/access";
import { addDomain, domainAction } from "../../../platform-actions";

export default async function Domains({ params }: { params: Promise<{ id: string }> }) {
  const { workload: w } = await requireWorkload((await params).id);
  const t = await getT();
  return (
    <div className="space-y-6">
      <Card>
        <Table head={[t("Domain"), "", ""]}>
          {w.domains.map((d) => (
            <tr key={d.id}>
              <Td><a href={`https://${d.hostname}`} target="_blank" rel="noopener noreferrer" className="font-medium hover:text-link">{d.hostname}</a></Td>
              <Td className="space-x-1">
                {d.isPrimary && <Badge tone="info">{t("Primary")}</Badge>}
                {d.isSystem && <Badge>{t("Included")}</Badge>}
              </Td>
              <Td className="text-right">
                <form action={domainAction} className="inline-flex gap-1">
                  <input type="hidden" name="id" value={w.id} />
                  <input type="hidden" name="domainId" value={d.id} />
                  {!d.isPrimary && <Button name="action" value="primary" size="sm" variant="ghost">{t("Make primary")}</Button>}
                  {!d.isSystem && <Button name="action" value="remove" size="sm" variant="ghost">{t("Remove")}</Button>}
                </form>
              </Td>
            </tr>
          ))}
        </Table>
      </Card>
      <Card>
        <CardHeader
          title={t("Add a domain")}
          description={w.node.publicIp ? t("First point an A record to {ip}. The SSL certificate is issued automatically on the first visit.", { ip: w.node.publicIp }) : t("Point the domain to this server first. The SSL certificate is issued automatically on the first visit.")}
        />
        <div className="p-5">
          <ActionForm action={addDomain} className="flex max-w-xl flex-wrap items-start gap-3">
            <input type="hidden" name="id" value={w.id} />
            <Input name="hostname" placeholder="www.example.com" required className="flex-1" autoCapitalize="none" spellCheck={false} />
            <SubmitButton>{t("Add domain")}</SubmitButton>
          </ActionForm>
        </div>
      </Card>
    </div>
  );
}
