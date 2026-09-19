import { getUser } from "@/lib/auth";
import { previewTemplate } from "@/lib/notify";

export const dynamic = "force-dynamic";

export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getUser();
  if (user?.role !== "admin") return new Response("Not found", { status: 404 });
  const html = await previewTemplate(decodeURIComponent((await params).id));
  if (!html) return new Response("Not found", { status: 404 });
  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      // Admin-authored text rendered as a document: sandboxed into an opaque
      // origin, no scripts, no network. (Sandboxing here rather than on the
      // <iframe> keeps the session cookie on the request for this route.)
      "Content-Security-Policy": "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src https: data:",
      "Cache-Control": "private, no-store",
    },
  });
}
