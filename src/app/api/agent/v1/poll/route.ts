import { authenticateAgent } from "@/platform/agent-auth";
import { claimJobs, heartbeat, recordMetrics } from "@/platform/engine";
import type { PollRequest, PollResponse } from "@/platform/protocol";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const node = await authenticateAgent(request);
  if (!node) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const poll = (await request.json().catch(() => ({}))) as PollRequest;
  await heartbeat(node.id, poll);
  await recordMetrics(node.id, poll.workloads ?? []).catch(() => {});
  const capacity = Math.min(Math.max(Number(poll.capacity) || 0, 0), 8);
  const body: PollResponse = { jobs: capacity ? await claimJobs(node.id, capacity) : [], pollIntervalMs: 3000 };
  return Response.json(body);
}
