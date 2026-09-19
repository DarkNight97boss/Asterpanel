import { safeEqual } from "@/lib/crypto";
import { prometheusMetrics } from "@/lib/node-health";
import { getSettings } from "@/lib/settings";

export const dynamic = "force-dynamic";

/** Prometheus scrape target. Off until a token is set; the token is the only credential. */
export async function GET(request: Request) {
  const { metricsToken } = await getSettings("platform");
  const given = /^Bearer\s+(\S+)$/i.exec(request.headers.get("authorization") ?? "")?.[1] ?? "";
  if (!metricsToken || !given || !safeEqual(given, metricsToken)) return new Response("Not found", { status: 404 });
  return new Response(await prometheusMetrics(), { headers: { "Content-Type": "text/plain; version=0.0.4; charset=utf-8", "Cache-Control": "no-store" } });
}
