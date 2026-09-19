import { runAutomation } from "@/lib/billing";
import { safeEqual } from "@/lib/crypto";
import { flushNotifications } from "@/lib/notify";
import { runScheduledBackups } from "@/platform/engine";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Billing run. Call daily: `Authorization: Bearer $CRON_SECRET`. */
async function handle(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return Response.json({ error: "CRON_SECRET is not configured" }, { status: 503 });
  const token = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!safeEqual(token, secret)) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const report = await runAutomation();
  const backups = await runScheduledBackups();
  await flushNotifications();
  return Response.json({ ...report, backups });
}

export { handle as GET, handle as POST };
