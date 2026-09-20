import { ActionForm, SubmitButton } from "@/components/action-form";
import { ProfileFields } from "@/components/profile-fields";
import { Alert, Button, Card, CardHeader, Field, Input, PageHeader } from "@/components/ui";
import QRCode from "qrcode";
import { getLocale, getT } from "@/i18n";
import { formatDate, formatDateTime } from "@/lib/format";
import { getSettings } from "@/lib/settings";
import { otpauthUrl, pendingSecret } from "@/lib/totp";
import { listSessions, requireUser } from "@/lib/auth";
import { listPasskeys } from "@/lib/passkeys";
import { PasskeyAdd } from "@/components/passkey-buttons";
import { changePassword, confirmTwoFactor, deletePasskey, disableTwoFactor, signOutSession, startTwoFactor, updateProfile } from "../actions";

export default async function Profile({ searchParams }: { searchParams: Promise<{ need2fa?: string }> }) {
  const need2fa = (await searchParams).need2fa === "1";
  const [user, t, locale, general] = await Promise.all([requireUser(), getT(), getLocale(), getSettings("general")]);
  const [secret, sessions, passkeys] = await Promise.all([pendingSecret(user.id), listSessions(user.id), listPasskeys(user.id)]);
  // The QR is rendered on the server: the secret never reaches a third-party QR service.
  const enrolling = secret ? { secret, qr: await QRCode.toString(otpauthUrl(general.siteName, user.email, secret), { type: "svg", margin: 0 }) } : null;
  return (
    <>
      <PageHeader title={t("Profile")} description={user.email} />
      {need2fa && !user.totpEnabledAt && <div className="mb-6"><Alert tone="warning">{t("This company requires two-factor authentication. Set it up below to continue.")}</Alert></div>}
      <div className="space-y-6">
        <Card>
          <CardHeader title={t("Contact & billing details")} description={t("Shown on your invoices.")} />
          <div className="p-5">
            <ActionForm action={updateProfile}>
              <ProfileFields user={user} />
              <SubmitButton>{t("Save")}</SubmitButton>
            </ActionForm>
          </div>
        </Card>
        <Card>
          <CardHeader title={t("Change password")} description={t("Other devices will be signed out.")} />
          <div className="max-w-md p-5">
            <ActionForm action={changePassword}>
              <Field label={t("Current password")}>
                <Input name="currentPassword" type="password" autoComplete="current-password" required />
              </Field>
              <Field label={t("New password")} hint={t("At least 10 characters.")}>
                <Input name="newPassword" type="password" autoComplete="new-password" minLength={10} required />
              </Field>
              <SubmitButton>{t("Update password")}</SubmitButton>
            </ActionForm>
          </div>
        </Card>
        <Card>
          <CardHeader title={t("Two-factor authentication")} description={t("A code from an app on your phone is asked after your password. Stops attackers who have stolen or guessed it.")} />
          <div className="p-6 pt-4">
            {user.totpEnabledAt ? (
              <div className="max-w-md">
                <p className="mb-4 text-sm text-success">✓ {t("On since {date}", { date: formatDate(user.totpEnabledAt, locale) })}</p>
                <ActionForm action={disableTwoFactor}>
                  <Field label={t("Code")} hint={t("Enter a current code (or a recovery code) to turn it off.")}><Input name="code" inputMode="numeric" autoComplete="one-time-code" required /></Field>
                  <SubmitButton variant="secondary">{t("Turn off two-factor authentication")}</SubmitButton>
                </ActionForm>
              </div>
            ) : enrolling ? (
              <div className="grid gap-8 md:grid-cols-[auto_1fr]">
                <div className="w-44 rounded-theme border border-border bg-white p-2" dangerouslySetInnerHTML={{ __html: enrolling.qr }} />
                <div className="max-w-md">
                  <p className="mb-2 text-sm">{t("1. Scan the QR code with Google Authenticator, 1Password, Authy or a similar app.")}</p>
                  <p className="mb-4 text-xs text-muted">{t("Cannot scan? Enter this key by hand:")} <code className="font-mono break-all select-all">{enrolling.secret}</code></p>
                  <ActionForm action={confirmTwoFactor}>
                    <Field label={t("2. Enter the code the app shows")}><Input name="code" inputMode="numeric" autoComplete="one-time-code" required maxLength={7} /></Field>
                    <SubmitButton>{t("Turn on")}</SubmitButton>
                  </ActionForm>
                </div>
              </div>
            ) : (
              <form action={startTwoFactor}><Button>{t("Set up two-factor authentication")}</Button></form>
            )}
          </div>
        </Card>
        <Card>
          <CardHeader title={t("Passkeys")} description={t("Sign in with your fingerprint, face or a security key instead of the password. A passkey cannot be phished or guessed, and asks for no code.")} />
          <div className="space-y-4 p-5 pt-0">
            {passkeys.length > 0 && (
              <ul className="divide-y divide-border rounded-theme border border-border text-sm">
                {passkeys.map((p) => (
                  <li key={p.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-2.5">
                    <span><span className="font-medium">{p.name}</span> <span className="text-muted">· {t("added {date}", { date: formatDate(p.createdAt, locale) })}{p.lastUsedAt ? ` · ${t("last used {date}", { date: formatDate(p.lastUsedAt, locale) })}` : ""}</span></span>
                    <form action={deletePasskey}><input type="hidden" name="id" value={p.id} /><Button size="sm" variant="ghost">{t("Remove")}</Button></form>
                  </li>
                ))}
              </ul>
            )}
            <PasskeyAdd labels={{ signIn: "", add: t("Add a passkey"), name: t("Name, e.g. MacBook"), cancelled: t("Cancelled, or no passkey was chosen."), failed: t("The passkey did not work. Try again.") }} />
          </div>
        </Card>
        <Card>
          <CardHeader title={t("Active sessions")} description={t("Devices signed in to your account. Sign out the ones you do not recognise, then change your password.")} />
          <ul className="divide-y divide-border">
            {sessions.map((s) => (
              <li key={s.handle} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3 text-sm">
                <div className="min-w-0">
                  <p className="truncate font-medium">{device(s.userAgent)} {s.current && <span className="ml-2 text-xs font-normal text-success">● {t("This device")}</span>}</p>
                  <p className="text-xs text-muted">{s.ip || "—"} · {formatDateTime(s.createdAt, locale)}</p>
                </div>
                {!s.current && (
                  <form action={signOutSession}>
                    <input type="hidden" name="handle" value={s.handle} />
                    <Button size="sm" variant="ghost">{t("Sign out")}</Button>
                  </form>
                )}
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </>
  );
}

/** "Chrome on macOS" from a user agent; the raw string when nothing matches. */
function device(ua: string) {
  const browser = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "";
  const os = /Windows/.test(ua) ? "Windows" : /iPhone|iPad/.test(ua) ? "iOS" : /Mac OS X/.test(ua) ? "macOS" : /Android/.test(ua) ? "Android" : /Linux/.test(ua) ? "Linux" : "";
  return browser && os ? `${browser} · ${os}` : ua.slice(0, 60) || "—";
}
