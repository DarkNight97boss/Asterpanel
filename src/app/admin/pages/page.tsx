import Link from "next/link";
import { asc } from "drizzle-orm";
import { ButtonLink, Card, EmptyState, PageHeader, StatusBadge, STATUS_LABEL, Table, Td } from "@/components/ui";
import { getDb, schema } from "@/db";
import { getLocale, getT } from "@/i18n";
import { formatDateTime } from "@/lib/format";
import { ConfirmButton } from "@/components/confirm-button";
import { installPlatformHome } from "../actions";

export default async function Pages() {
  const db = await getDb();
  const [t, locale, pages] = await Promise.all([getT(), getLocale(), db.select().from(schema.pages).orderBy(asc(schema.pages.slug))]);
  return (
    <>
      <PageHeader title={t("Pages")} description={t("Build your website from blocks.")} action={
          <>
            <form action={installPlatformHome}>
              <ConfirmButton variant="secondary" message={t("Replace the current home page with the platform template?")}>{t("Install platform home page")}</ConfirmButton>
            </form>
            <ButtonLink href="/admin/pages/new">{t("New page")}</ButtonLink>
          </>
        }
      />
      <Card>
        {pages.length ? (
          <Table head={[t("Title"), t("URL"), t("Updated"), t("Status")]}>
            {pages.map((p) => (
              <tr key={p.id}>
                <Td><Link href={`/admin/pages/${p.id}`} className="font-medium hover:text-link">{p.title}</Link></Td>
                <Td className="font-mono text-xs">/{p.slug}</Td>
                <Td>{formatDateTime(p.updatedAt, locale)}</Td>
                <Td><StatusBadge status={p.status} label={t(STATUS_LABEL[p.status])} /></Td>
              </tr>
            ))}
          </Table>
        ) : (
          <EmptyState title={t("No pages yet")} />
        )}
      </Card>
    </>
  );
}
