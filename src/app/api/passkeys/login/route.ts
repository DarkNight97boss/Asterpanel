import { audit } from "@/lib/audit";
import { createSession } from "@/lib/auth";
import { finishLogin, loginOptions, PasskeyError } from "@/lib/passkeys";
import { rateLimit } from "@/lib/rate-limit";
import { requestMeta } from "@/lib/request";
import { rememberChallenge, site, takeChallenge } from "../shared";

export const dynamic = "force-dynamic";

export async function GET() {
  const options = await loginOptions(await site());
  await rememberChallenge("login", options.challenge);
  return Response.json(options);
}

/** A verified passkey (user verification required) signs in by itself: it already is two factors. */
export async function POST(request: Request) {
  const { ip } = await requestMeta();
  if (!rateLimit(`passkey:${ip}`, 10, 10 * 60_000)) return Response.json({ error: "Too many attempts. Try again in a few minutes." }, { status: 429 });
  const challenge = await takeChallenge("login");
  const body = (await request.json().catch(() => null)) as { response?: never } | null;
  if (!challenge || !body?.response) return Response.json({ error: "Start again" }, { status: 400 });
  try {
    const userId = await finishLogin(body.response, challenge, await site());
    await createSession(userId);
    await audit(userId, "auth.login", "user", userId, { passkey: true });
    return Response.json({ ok: true });
  } catch (err) {
    if (err instanceof PasskeyError) return Response.json({ error: err.message }, { status: 400 });
    throw err;
  }
}
