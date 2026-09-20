import { renderSiteReportPdf, ReportError, siteReport } from "@/lib/site-report";
import { requireWorkload } from "@/platform/access";

export const dynamic = "force-dynamic";

/** Monthly PDF report of a site (`?month=2026-08`), for whoever may open the site. */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { workload } = await requireWorkload((await params).id);
  if (workload.type === "database") return new Response("Not found", { status: 404 });
  try {
    const { filename, bytes } = await renderSiteReportPdf(await siteReport(workload.id, new URL(request.url).searchParams.get("month") ?? ""));
    return new Response(Buffer.from(bytes), { headers: { "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename="${filename}"`, "Cache-Control": "private, no-store" } });
  } catch (err) {
    if (err instanceof ReportError) return new Response(err.message, { status: 400 });
    throw err;
  }
}
