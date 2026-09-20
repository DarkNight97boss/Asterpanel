"use client";

import { useState } from "react";
import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import { Button, Input } from "@/components/ui";

type Labels = Record<"signIn" | "add" | "name" | "cancelled" | "failed", string>;

async function ceremony<T>(path: string, run: (options: never) => Promise<T>, extra: Record<string, unknown> = {}): Promise<string | null> {
  const options = await fetch(path, { cache: "no-store" }).then((r) => r.json());
  if (options.error) return options.error;
  const response = await run(options as never);
  const result = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ response, ...extra }) }).then((r) => r.json());
  return result.ok ? null : (result.error ?? "failed");
}

const message = (err: unknown, labels: Labels) => (err instanceof Error && (err.name === "NotAllowedError" || err.name === "AbortError") ? labels.cancelled : labels.failed);

/** Sign-in page: the browser offers the passkeys it holds for this site; no email needed. */
export function PasskeySignIn({ next, labels }: { next: string; labels: Labels }) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    setError("");
    try {
      const failed = await ceremony("/api/passkeys/login", (optionsJSON) => startAuthentication({ optionsJSON }));
      // The sign-in page sends whoever has a session to the right place, honouring a safe `next`.
      if (!failed) return window.location.assign(`/login${next ? `?next=${encodeURIComponent(next)}` : ""}`);
      setError(failed);
    } catch (err) {
      setError(message(err, labels));
    }
    setBusy(false);
  };
  return (
    <div className="space-y-2">
      <Button type="button" variant="secondary" className="w-full" onClick={go} disabled={busy}>{labels.signIn}</Button>
      {error && <p role="alert" className="text-center text-sm text-danger">{error}</p>}
    </div>
  );
}

/** Profile: adds a passkey of this device (or a security key) to the signed-in user. */
export function PasskeyAdd({ labels }: { labels: Labels }) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState("");
  const go = async () => {
    setBusy(true);
    setError("");
    try {
      const failed = await ceremony("/api/passkeys/register", (optionsJSON) => startRegistration({ optionsJSON }), { name });
      if (!failed) return window.location.reload();
      setError(failed);
    } catch (err) {
      setError(message(err, labels));
    }
    setBusy(false);
  };
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-3">
        <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} placeholder={labels.name} className="max-w-xs" />
        <Button type="button" onClick={go} disabled={busy}>{labels.add}</Button>
      </div>
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
    </div>
  );
}
