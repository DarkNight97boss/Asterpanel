import { forgetInstallation, reportCommitStatus, verifyGithubSignature, workloadsForPush } from "@/lib/github";
import { rateLimit } from "@/lib/rate-limit";
import { handlePush, parsePush, PlatformError } from "@/platform/engine";

export const dynamic = "force-dynamic";

type Payload = { after?: string; repository?: { full_name?: string }; installation?: { id?: number }; action?: string };

/** Webhook of the GitHub App: pushes deploy (or build previews), an uninstall disconnects. */
export async function POST(request: Request) {
  const payload = await request.text();
  if (!(await verifyGithubSignature(payload, request.headers.get("x-hub-signature-256")))) return Response.json({ error: "Invalid signature" }, { status: 401 });
  const event = request.headers.get("x-github-event");
  let body: Payload;
  try {
    body = JSON.parse(payload) as Payload;
  } catch {
    return Response.json({ error: "Invalid payload" }, { status: 400 });
  }
  const installationId = String(body.installation?.id ?? "");

  if (event === "installation" && body.action === "deleted" && installationId) {
    await forgetInstallation(installationId);
    return Response.json({ ok: true });
  }
  if (event !== "push" || !body.repository?.full_name || !installationId) return Response.json({ ignored: true });

  const push = parsePush(body);
  const results: Record<string, string> = {};
  for (const w of await workloadsForPush(body.repository.full_name, installationId)) {
    if (!rateLimit(`deploy:${w.id}`, 12, 10 * 60_000)) {
      results[w.id] = "rate_limited";
      continue;
    }
    try {
      const r = await handlePush(w.id, push);
      results[w.id] = r.action;
      if ((r.action === "deployed" || r.action === "preview") && body.after) await reportCommitStatus(w, body.after, "pending", "Deploying…", "");
    } catch (err) {
      if (!(err instanceof PlatformError)) throw err;
      results[w.id] = err.message;
    }
  }
  return Response.json({ results }, { status: 202 });
}
