import { getUser } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { connectInstallation, GithubError, stateWorkload } from "@/lib/github";
import { baseUrl } from "@/lib/url";
import { requireWorkload } from "@/platform/access";

export const dynamic = "force-dynamic";

/** "Setup URL" of the GitHub App: GitHub sends the customer back here after installing it. */
export async function GET(request: Request) {
  const origin = await baseUrl();
  const user = await getUser();
  if (!user) return Response.redirect(`${origin}/login`, 303);
  const q = new URL(request.url).searchParams;
  try {
    // Same access rules as the page itself, checked before anything is written.
    const expected = stateWorkload(q.get("state") ?? "", user.id);
    if (!expected) throw new GithubError("This link has expired. Start again from the Deployments page.");
    const { canManage } = await requireWorkload(expected);
    if (!canManage) throw new GithubError("Only owners and administrators can connect GitHub");
    const workloadId = await connectInstallation({ state: q.get("state") ?? "", installationId: q.get("installation_id") ?? "", code: q.get("code") ?? "", userId: user.id });
    await audit(user.id, "github.connected", "workload", workloadId);
    return Response.redirect(`${origin}/client/workloads/${workloadId}/deployments?github=connected`, 303);
  } catch (err) {
    if (!(err instanceof GithubError)) throw err;
    return new Response(err.message, { status: 400, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }
}
