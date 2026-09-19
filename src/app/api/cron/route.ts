import { runAutomation } from "@/lib/billing";
import { safeEqual } from "@/lib/crypto";
import { flushNotifications } from "@/lib/notify";
import { syncDueDomains } from "@/lib/domains";
import { runAutoCharges } from "@/lib/payment-methods";
import { pollSdi } from "@/lib/sdi";
import { maintainCapacity, syncCloudNodes } from "@/lib/cloud";
import { runScheduledBackups } from "@/platform/engine";
import { runUptimeChecks } from "@/platform/uptime";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Billing run. Call daily: `Authorization: Bearer $CRON_SECRET`. */
async function handle(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return Response.json({ error: "CRON_SECRET is not configured" }, { status: 503 });
  const token = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!safeEqual(token, secret)) return Response.json({ error: "Unauthorized" }, { status: 401 });
  // `?only=uptime` is the cheap, frequent call (every few minutes); the full run is daily/hourly.
  if (new URL(request.url).searchParams.get("only") === "uptime") {
    const uptime = await runUptimeChecks();
    await flushNotifications();
    return Response.json({ uptime });
  }
  const report = await runAutomation();
  // After the billing run, so renewals issued a moment ago are charged in the same pass.
  const charges = await runAutoCharges().catch(() => ({ paid: 0, failed: 0 }));
  const sdi = await pollSdi().catch(() => 0);
  await syncCloudNodes().catch(() => 0);
  const capacity = await maintainCapacity().catch(() => ({ created: 0, removed: 0 }));
  const backups = await runScheduledBackups();
  const domains = await syncDueDomains().catch(() => 0);
  const uptime = await runUptimeChecks();
  await flushNotifications();
  return Response.json({ ...report, charges, sdi, capacity, backups, domains, uptime });
}

export { handle as GET, handle as POST };
