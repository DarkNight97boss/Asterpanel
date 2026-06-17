// WebAuthn (passkey) ceremony client. Translates the base64url <-> ArrayBuffer
// fields the browser's navigator.credentials API needs, and posts the result to
// the control plane's begin/finish endpoints.

import { apiGet, apiPost } from "@/lib/api";

function b64urlToBuf(s: string): ArrayBuffer {
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  const b64 = (s + pad).replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf.buffer;
}

function bufToB64url(b: ArrayBuffer): string {
  const bytes = new Uint8Array(b);
  let s = "";
  for (const x of bytes) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function passkeysSupported(): boolean {
  return typeof window !== "undefined" && !!window.PublicKeyCredential;
}

/* eslint-disable @typescript-eslint/no-explicit-any */

export async function registerPasskey(name: string): Promise<void> {
  const opts = await apiPost<{ publicKey: any }>("/api/v1/auth/webauthn/register/begin");
  const pk = opts.publicKey;
  pk.challenge = b64urlToBuf(pk.challenge);
  pk.user.id = b64urlToBuf(pk.user.id);
  (pk.excludeCredentials ?? []).forEach((c: any) => (c.id = b64urlToBuf(c.id)));

  const cred = (await navigator.credentials.create({ publicKey: pk })) as PublicKeyCredential;
  const att = cred.response as AuthenticatorAttestationResponse;
  await apiPost(`/api/v1/auth/webauthn/register/finish?name=${encodeURIComponent(name)}`, {
    id: cred.id,
    rawId: bufToB64url(cred.rawId),
    type: cred.type,
    response: {
      clientDataJSON: bufToB64url(att.clientDataJSON),
      attestationObject: bufToB64url(att.attestationObject),
    },
  });
}

export async function loginWithPasskey(email: string): Promise<void> {
  const begin = await apiPost<{ assertion: { publicKey: any }; login_token: string }>(
    "/api/v1/auth/webauthn/login/begin",
    { email },
  );
  const pk = begin.assertion.publicKey;
  pk.challenge = b64urlToBuf(pk.challenge);
  (pk.allowCredentials ?? []).forEach((c: any) => (c.id = b64urlToBuf(c.id)));

  const cred = (await navigator.credentials.get({ publicKey: pk })) as PublicKeyCredential;
  const asr = cred.response as AuthenticatorAssertionResponse;
  await apiPost(
    `/api/v1/auth/webauthn/login/finish?token=${encodeURIComponent(begin.login_token)}`,
    {
      id: cred.id,
      rawId: bufToB64url(cred.rawId),
      type: cred.type,
      response: {
        clientDataJSON: bufToB64url(asr.clientDataJSON),
        authenticatorData: bufToB64url(asr.authenticatorData),
        signature: bufToB64url(asr.signature),
        userHandle: asr.userHandle ? bufToB64url(asr.userHandle) : null,
      },
    },
  );
}

export async function listPasskeys(): Promise<{ id: string; name: string | null }[]> {
  const { passkeys } = await apiGet<{ passkeys: { id: string; name: string | null }[] }>(
    "/api/v1/auth/webauthn/passkeys",
  );
  return passkeys ?? [];
}
