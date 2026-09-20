import "server-only";
import { and, eq, gte, lt } from "drizzle-orm";
import { PDFDocument, StandardFonts, rgb, type PDFFont, type RGB } from "pdf-lib";
import { getDb, schema } from "@/db";
import { makeT } from "@/i18n/shared";
import { formatDate } from "./format";
import { encodable, hexToRgb } from "./invoice-pdf";
import { getSettings } from "./settings";

/**
 * Monthly report of one site, as a PDF an agency can hand to its customer:
 * availability, speed, backups, deployments, security. Only what the panel
 * really measured; a month without data says so instead of showing 100%.
 */

export class ReportError extends Error {}

/** `YYYY-MM` → the month's UTC bounds. Months that have not ended yet are allowed (report so far), future ones are not. */
export function monthRange(month: string, now = new Date()): { from: Date; to: Date; label: string } {
  const m = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(month);
  if (!m) throw new ReportError("The month looks like 2026-08");
  const from = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, 1));
  const to = new Date(Date.UTC(Number(m[1]), Number(m[2]), 1));
  if (from > now || from.getUTCFullYear() < 2020) throw new ReportError("No data for this month");
  return { from, to, label: month };
}

/** The last `count` months, newest first, the current one included. */
export function recentMonths(count: number, now = new Date()): string[] {
  return Array.from({ length: count }, (_, i) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1)).toISOString().slice(0, 7));
}

export type SiteReport = {
  site: { name: string; type: string; host: string; createdAt: Date };
  month: string;
  uptime: { percent: number; avgMs: number | null; checks: number; daysMeasured: number; daysWithDowntime: string[] } | null;
  backups: { made: number; failed: number; offsite: number; latest: Date | null };
  deployments: { live: number; failed: number; rollbacks: number } | null;
  security: { lastScan: Date | null; findings: number | null; autoUpdates: string; lastUpdateRun: Date | null } | null;
  diskUsedMb: number | null;
};

export async function siteReport(workloadId: string, month: string, now = new Date()): Promise<SiteReport> {
  const { from, to } = monthRange(month, now);
  const db = await getDb();
  const w = await db.query.workloads.findFirst({ where: eq(schema.workloads.id, workloadId), with: { domains: true } });
  if (!w) throw new ReportError("Site not found");
  const inMonth = <T extends { createdAt: Date }>(rows: T[]) => rows.filter((r) => r.createdAt >= from && r.createdAt < to);
  const [days, backups, deployments] = await Promise.all([
    db.select().from(schema.uptimeDaily).where(and(eq(schema.uptimeDaily.workloadId, w.id), gte(schema.uptimeDaily.day, from.toISOString().slice(0, 10)), lt(schema.uptimeDaily.day, to.toISOString().slice(0, 10)))),
    db.select().from(schema.backups).where(eq(schema.backups.workloadId, w.id)).then(inMonth),
    db.select().from(schema.deployments).where(eq(schema.deployments.workloadId, w.id)).then(inMonth),
  ]);
  const checks = days.reduce((n, d) => n + d.checks, 0);
  const up = days.reduce((n, d) => n + d.up, 0);
  const made = backups.filter((b) => b.status === "ready" || b.status === "restoring");
  const date = (iso?: string) => (iso && !Number.isNaN(Date.parse(iso)) ? new Date(iso) : null);
  return {
    site: { name: w.name, type: w.type, host: (w.domains.find((d) => d.isPrimary) ?? w.domains[0])?.hostname ?? "", createdAt: w.createdAt },
    month,
    uptime: checks
      ? { percent: Math.floor((up / checks) * 10_000) / 100, avgMs: up ? Math.round(days.reduce((n, d) => n + d.msSum, 0) / up) : null, checks, daysMeasured: days.length, daysWithDowntime: days.filter((d) => d.up < d.checks).map((d) => d.day).sort() }
      : null,
    backups: { made: made.length, failed: backups.filter((b) => b.status === "failed").length, offsite: made.filter((b) => b.offsite === "uploaded").length, latest: made.reduce<Date | null>((l, b) => (!l || b.createdAt > l ? b.createdAt : l), null) },
    deployments: w.type === "app" || w.type === "static" ? { live: deployments.filter((d) => d.status === "live" && d.trigger !== "rollback").length, failed: deployments.filter((d) => d.status === "failed").length, rollbacks: deployments.filter((d) => d.trigger === "rollback").length } : null,
    security: w.type === "wordpress" ? { lastScan: date(w.config.scanLastAt), findings: w.config.scanLastAt ? (w.config.scanFindings ?? 0) : null, autoUpdates: w.config.autoUpdate ?? "off", lastUpdateRun: date(w.config.autoUpdateLastAt) } : null,
    diskUsedMb: w.runtime.diskUsedMb ?? null,
  };
}

const A4 = { width: 595.28, height: 841.89 };
const MARGIN = 48;
const INK = rgb(0.06, 0.09, 0.16);
const MUTED = rgb(0.36, 0.4, 0.47);
const RULE = rgb(0.89, 0.9, 0.93);
const GOOD = rgb(0.08, 0.5, 0.24);
const BAD = rgb(0.72, 0.15, 0.12);

export async function renderSiteReportPdf(report: SiteReport): Promise<{ filename: string; bytes: Uint8Array }> {
  const [general, theme] = await Promise.all([getSettings("general"), getSettings("theme")]);
  const t = makeT(general.locale);
  const locale = general.locale;
  const brand = hexToRgb(theme.primary);
  const pdf = await PDFDocument.create();
  const title = `${t("Monthly report")} ${report.month} - ${report.site.name}`;
  pdf.setTitle(title);
  pdf.setAuthor(general.companyName || general.siteName);
  pdf.setCreator("AsterPanel");
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  let page = pdf.addPage([A4.width, A4.height]);
  let y = A4.height - MARGIN;

  const draw = (raw: string, x: number, atY: number, { font = regular, size = 10, color = INK, right = false }: { font?: PDFFont; size?: number; color?: RGB; right?: boolean } = {}) => {
    const text = encodable(font, raw);
    page.drawText(text, { x: right ? x - font.widthOfTextAtSize(text, size) : x, y: atY, size, font, color });
  };
  const ensure = (space: number) => {
    if (y - space > MARGIN + 20) return;
    page = pdf.addPage([A4.width, A4.height]);
    y = A4.height - MARGIN;
  };
  const section = (name: string) => {
    ensure(90);
    y -= 26;
    draw(name, MARGIN, y, { font: bold, size: 12, color: brand });
    y -= 8;
    page.drawLine({ start: { x: MARGIN, y }, end: { x: A4.width - MARGIN, y }, thickness: 0.75, color: RULE });
    y -= 6;
  };
  const row = (label: string, value: string, color: RGB = INK) => {
    ensure(20);
    y -= 16;
    draw(label, MARGIN, y, { color: MUTED });
    draw(value, A4.width - MARGIN, y, { font: bold, color, right: true });
  };
  const note = (text: string) => {
    ensure(20);
    y -= 16;
    draw(text, MARGIN, y, { color: MUTED, size: 9 });
  };

  draw(general.companyName || general.siteName, MARGIN, y - 14, { font: bold, size: 18, color: brand });
  draw(`${t("Monthly report")} ${report.month}`, A4.width - MARGIN, y - 12, { font: bold, size: 14, right: true });
  y -= 44;
  draw(report.site.name, MARGIN, y, { font: bold, size: 13 });
  y -= 15;
  draw(report.site.host || "-", MARGIN, y, { color: MUTED });

  section(t("Availability"));
  if (report.uptime) {
    const u = report.uptime;
    row(t("Uptime"), `${u.percent.toFixed(2)}%`, u.percent >= 99.9 ? GOOD : u.percent >= 99 ? INK : BAD);
    row(t("Average response time"), u.avgMs === null ? "-" : `${u.avgMs} ms`);
    row(t("Checks made"), `${u.checks} (${t("{n} days", { n: u.daysMeasured })})`);
    row(t("Days with failed checks"), u.daysWithDowntime.length ? u.daysWithDowntime.map((d) => d.slice(8)).join(", ") : t("none"), u.daysWithDowntime.length ? BAD : GOOD);
    note(t("Measured from outside the server, the way a visitor arrives."));
  } else note(t("No availability checks were recorded in this month."));

  section(t("Backups"));
  row(t("Backups made"), String(report.backups.made), report.backups.made ? GOOD : INK);
  if (report.backups.offsite) row(t("Also copied off-site"), String(report.backups.offsite));
  if (report.backups.failed) row(t("Failed"), String(report.backups.failed), BAD);
  row(t("Latest backup"), report.backups.latest ? formatDate(report.backups.latest, locale) : "-");

  if (report.deployments) {
    section(t("Deployments"));
    row(t("Released"), String(report.deployments.live));
    row(t("Failed"), String(report.deployments.failed), report.deployments.failed ? BAD : INK);
    row(t("Rollbacks"), String(report.deployments.rollbacks));
  }
  if (report.security) {
    const s = report.security;
    section(t("Security and updates"));
    row(t("Latest malware scan"), s.lastScan ? formatDate(s.lastScan, locale) : t("never"));
    if (s.findings !== null) row(t("Suspicious files"), String(s.findings), s.findings ? BAD : GOOD);
    row(t("Automatic updates"), t(s.autoUpdates === "all" ? "Everything, major versions included" : s.autoUpdates === "minor" ? "Security and minor releases only" : "Off"));
    if (s.lastUpdateRun) row(t("Latest update run"), formatDate(s.lastUpdateRun, locale));
    note(t("State at the time this report was made."));
  }
  if (report.diskUsedMb !== null) {
    section(t("Resources"));
    row(t("Disk used"), report.diskUsedMb >= 1024 ? `${(report.diskUsedMb / 1024).toFixed(1)} GB` : `${report.diskUsedMb} MB`);
  }

  draw(`${t("Generated on")} ${formatDate(new Date(), locale)}`, MARGIN, MARGIN - 10, { size: 8, color: MUTED });
  const safe = report.site.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "site";
  return { filename: `report-${safe}-${report.month}.pdf`, bytes: await pdf.save() };
}
