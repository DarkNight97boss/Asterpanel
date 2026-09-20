import { cookies } from "next/headers";
import { signValue, verifyValue } from "@/lib/crypto";
import { getSettings } from "@/lib/settings";
import { baseUrl } from "@/lib/url";
import type { Site } from "@/lib/passkeys";

const COOKIE = "aster_webauthn";

export const site = async (): Promise<Site> => ({ origin: await baseUrl(), name: (await getSettings("general")).siteName });

/** The challenge lives five minutes in a signed, http-only cookie, tagged with what it was issued for. */
export async function rememberChallenge(purpose: "register" | "login", challenge: string) {
  (await cookies()).set(COOKIE, signValue(`${purpose}:${challenge}`, 5 * 60_000), { httpOnly: true, sameSite: "strict", secure: process.env.NODE_ENV === "production", path: "/api/passkeys", maxAge: 300 });
}

/** One use: read and deleted together, so a captured response cannot be replayed. */
export async function takeChallenge(purpose: "register" | "login"): Promise<string | null> {
  const jar = await cookies();
  const value = verifyValue(jar.get(COOKIE)?.value);
  jar.delete({ name: COOKIE, path: "/api/passkeys" });
  return value?.startsWith(`${purpose}:`) ? value.slice(purpose.length + 1) : null;
}
