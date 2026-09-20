import { votePage } from "@/lib/pages";
import { rateLimit } from "@/lib/rate-limit";
import { requestMeta } from "@/lib/request";
import { getSettings } from "@/lib/settings";

export const dynamic = "force-dynamic";

/** "Was this helpful?" — one answer per article and address per day; a rough signal, not a ballot. */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as { slug?: unknown; helpful?: unknown } | null;
  const slug = String(body?.slug ?? "").slice(0, 200);
  const { ip } = await requestMeta();
  if (!slug || !rateLimit(`help-vote:${ip}:${slug}`, 1, 86_400_000) || !rateLimit(`help-vote:${ip}`, 30, 3_600_000)) return Response.json({ ok: false }, { status: 429 });
  const { helpPrefix } = await getSettings("general");
  return Response.json({ ok: !!helpPrefix && (await votePage(helpPrefix, slug, body?.helpful === true)) });
}
