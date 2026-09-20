import { safeEqual } from "@/lib/crypto";
import { getSettings } from "@/lib/settings";
import { handleInboundMail } from "@/lib/tickets";

export const dynamic = "force-dynamic";
const MAX_BYTES = 30 * 1024 * 1024;

/**
 * The mail server hands a received message over: the raw message as the body
 * (a pipe or a forwarder), or a form with the raw message in `body-mime`
 * (Mailgun) or `email` (SendGrid). Always answers 200 once authenticated:
 * a message we choose to ignore must not bounce or be retried for days.
 */
export async function POST(request: Request) {
  const { inboundEnabled, inboundToken } = await getSettings("mail");
  const given = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!inboundEnabled || !inboundToken || !safeEqual(given, inboundToken)) return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (Number(request.headers.get("content-length") ?? 0) > MAX_BYTES) return Response.json({ error: "Too large" }, { status: 413 });

  let raw: Buffer | string;
  if (/multipart\/form-data|application\/x-www-form-urlencoded/i.test(request.headers.get("content-type") ?? "")) {
    const form = await request.formData();
    const field = form.get("body-mime") ?? form.get("email");
    raw = typeof field === "string" ? field : field ? Buffer.from(await field.arrayBuffer()) : "";
  } else raw = Buffer.from(await request.arrayBuffer());
  if (!raw.length || raw.length > MAX_BYTES) return Response.json({ error: "No message" }, { status: 400 });

  const result = await handleInboundMail(raw).catch(() => ({ outcome: "ignored" as const, reason: "could not be read" }));
  return Response.json(result);
}
