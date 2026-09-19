import { and, desc, eq } from "drizzle-orm";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { AutoRefresh } from "@/components/auto-refresh";
import { Badge, Card, CardHeader, EmptyState, PageHeader, Table, Td } from "@/components/ui";
import { getDb, schema } from "@/db";
import { getLocale, getT } from "@/i18n";
import { formatDateTime } from "@/lib/format";
import { requireWorkload } from "@/platform/access";
import type { WpInventory } from "@/platform/protocol";
import { runTool } from "../../../platform-actions";

function ToolButton({ id, disabled, tool, kind, name, children, variant = "secondary" }: { id: string; disabled: boolean; tool: string; kind?: string; name?: string; children: React.ReactNode; variant?: "primary" | "secondary" | "ghost" }) {
  return (
    <ActionForm action={runTool} className="">
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="tool" value={tool} />
      {kind && <input type="hidden" name="kind" value={kind} />}
      {name && <input type="hidden" name="name" value={name} />}
      <SubmitButton size="sm" variant={variant} disabled={disabled}>{children}</SubmitButton>
    </ActionForm>
  );
}

export default async function PluginsAndThemes({ params }: { params: Promise<{ id: string }> }) {
  const { workload: w } = await requireWorkload((await params).id);
  const db = await getDb();
  const [t, locale, jobs] = await Promise.all([
    getT(),
    getLocale(),
    db.select().from(schema.jobs).where(and(eq(schema.jobs.workloadId, w.id), eq(schema.jobs.type, "workload.tool"))).orderBy(desc(schema.jobs.createdAt)).limit(12),
  ]);
  // The newest successful inventory among recent tool runs.
  let inventory: WpInventory | null = null;
  let scannedAt: Date | null = null;
  for (const j of jobs) {
    if (j.status !== "succeeded" || typeof j.result.output !== "string" || !j.result.output.startsWith("{")) continue;
    try {
      inventory = JSON.parse(j.result.output) as WpInventory;
      scannedAt = j.finishedAt;
      break;
    } catch {}
  }
  const busy = jobs.some((j) => j.status === "queued" || j.status === "running");
  const off = w.status !== "running";

  const common = { id: w.id, disabled: off || busy };

  const section = (kind: "plugin" | "theme", title: string, rows: WpInventory["plugins"]) => (
    <Card>
      <CardHeader title={title} description={t("{n} installed, {u} updates available", { n: rows.length, u: rows.filter((r) => r.update).length })} action={rows.some((r) => r.update) && <ToolButton {...common} tool="wp.update" kind={kind}>{t("Update all")}</ToolButton>} />
      <Table head={[t("Name"), t("Status"), t("Version"), ""]}>
        {rows.map((r) => (
          <tr key={r.name}>
            <Td><span className="font-medium">{r.title}</span><span className="block font-mono text-xs text-muted">{r.name}</span></Td>
            <Td>{r.status === "active" ? <Badge tone="success">{t("Active")}</Badge> : <Badge>{t("Inactive")}</Badge>}</Td>
            <Td>{r.version}{r.update && <span className="ml-2 text-xs text-warning">→ {r.update}</span>}</Td>
            <Td className="text-right">{r.update && <ToolButton {...common} tool="wp.update" kind={kind} name={r.name} variant="ghost">{t("Update")}</ToolButton>}</Td>
          </tr>
        ))}
      </Table>
    </Card>
  );

  return (
    <>
      <AutoRefresh active={busy} />
      <PageHeader
        title={t("Plugins and themes")}
        description={scannedAt ? t("WordPress {v} · last scan {date}", { v: inventory?.core ?? "", date: formatDateTime(scannedAt, locale) }) : undefined}
        action={<ToolButton {...common} tool="wp.inventory" variant="primary">{busy ? t("Working…") : inventory ? t("Scan again") : t("Scan site")}</ToolButton>}
      />
      {inventory ? (
        <div className="space-y-6">
          {section("plugin", t("Plugins"), inventory.plugins)}
          {section("theme", t("Themes"), inventory.themes)}
        </div>
      ) : (
        <Card><EmptyState title={t("Not scanned yet")} description={t("Scan the site to list its plugins and themes and see which updates are available.")} /></Card>
      )}
    </>
  );
}
