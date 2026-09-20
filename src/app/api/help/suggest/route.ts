import { searchPages } from "@/lib/pages";
import { rateLimit } from "@/lib/rate-limit";
import { requestMeta } from "@/lib/request";
import { getSettings } from "@/lib/settings";

export const dynamic = "force-dynamic";

/** Help articles that match what somebody is typing (the subject of a new ticket). Public content only. */
export async function GET(request: Request) {
  const { ip } = await requestMeta();
  if (!rateLimit(`help-suggest:${ip}`, 60, 60_000)) return Response.json({ articles: [] }, { status: 429 });
  const q = (new URL(request.url).searchParams.get("q") ?? "").slice(0, 200);
  const { helpPrefix } = await getSettings("general");
  const articles = helpPrefix ? await searchPages(helpPrefix, q, 5) : [];
  return Response.json({ articles: articles.map((a) => ({ title: a.title, excerpt: a.excerpt, href: `/${a.slug}` })) });
}
