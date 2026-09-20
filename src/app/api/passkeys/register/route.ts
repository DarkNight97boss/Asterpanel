import { getUser } from "@/lib/auth";
import { getImpersonator } from "@/lib/impersonation";
import { finishRegistration, PasskeyError, registrationOptions } from "@/lib/passkeys";
import { rememberChallenge, site, takeChallenge } from "../shared";

export const dynamic = "force-dynamic";

/** GET: options for a new passkey of the signed-in user. POST: the browser's answer. */
export async function GET() {
  const user = await getUser();
  // Staff looking through a customer's eyes must not leave a key of their own on the customer's account.
  if (!user || (await getImpersonator())) return Response.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const options = await registrationOptions(user, await site());
    await rememberChallenge("register", options.challenge);
    return Response.json(options);
  } catch (err) {
    if (err instanceof PasskeyError) return Response.json({ error: err.message }, { status: 400 });
    throw err;
  }
}

export async function POST(request: Request) {
  const user = await getUser();
  if (!user || (await getImpersonator())) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const challenge = await takeChallenge("register");
  const body = (await request.json().catch(() => null)) as { response?: never; name?: string } | null;
  if (!challenge || !body?.response) return Response.json({ error: "Start again" }, { status: 400 });
  try {
    await finishRegistration(user.id, body.response, challenge, await site(), String(body.name ?? ""));
    return Response.json({ ok: true });
  } catch (err) {
    if (err instanceof PasskeyError) return Response.json({ error: err.message }, { status: 400 });
    throw err;
  }
}
