import { authenticateAgent } from "@/platform/agent-auth";
import { reportJob } from "@/platform/engine";
import type { JobReport } from "@/platform/protocol";
import { flushNotifications } from "@/lib/notify";

export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const node = await authenticateAgent(request);
  if (!node) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const report = (await request.json().catch(() => null)) as JobReport | null;
  if (!/^[0-9a-f-]{36}$/i.test(id) || !report || !["running", "succeeded", "failed"].includes(report.status)) {
    return Response.json({ error: "Bad request" }, { status: 400 });
  }
  // A job that is unknown, foreign or already finished answers 409: the agent drops it.
  const accepted = await reportJob(node.id, id, report);
  await flushNotifications();
  return Response.json({ accepted }, { status: accepted ? 200 : 409 });
}
