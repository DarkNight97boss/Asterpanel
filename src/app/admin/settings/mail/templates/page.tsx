import Link from "next/link";
import { Badge, Card, PageHeader, Table, Td } from "@/components/ui";
import { getDb, schema } from "@/db";
import { getT } from "@/i18n";
import { requireAdmin } from "@/lib/auth";
import { TEMPLATES } from "@/lib/mail/templates";

export default async function EmailTemplates() {
  await requireAdmin();
  const db = await getDb();
  const [t, rows] = await Promise.all([getT(), db.select().from(schema.emailTemplates)]);
  const overrides = new Map(rows.map((r) => [r.id, r]));

  return (
    <>
      <PageHeader
        title={t("Email templates")}
        description={t("Change the wording of any notification, or switch it off.")}
        action={<Link href="/admin/settings/mail" className="text-sm text-link">← {t("Email")}</Link>}
      />
      <Card>
        <Table head={[t("Template"), t("Sent to"), t("Wording"), t("Status")]}>
          {TEMPLATES.map((def) => {
            const o = overrides.get(def.id);
            const customised = !!o && !!(o.subject || o.heading || o.body);
            return (
              <tr key={def.id}>
                <Td>
                  <Link href={`/admin/settings/mail/templates/${def.id}`} className="font-medium hover:text-link">{t(def.name)}</Link>
                  <span className="block text-xs text-muted">{t(def.description)}</span>
                </Td>
                <Td>{def.audience === "client" ? t("Client") : t("Staff")}</Td>
                <Td>{customised ? <Badge tone="info">{t("Customised")}</Badge> : <span className="text-muted">{t("Default")}</span>}</Td>
                <Td>{o && !o.enabled ? <Badge tone="danger">{t("Off")}</Badge> : <Badge tone="success">{t("On")}</Badge>}</Td>
              </tr>
            );
          })}
        </Table>
      </Card>
    </>
  );
}
