import Link from "next/link";
import { redirect } from "next/navigation";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { Alert, Field, Input } from "@/components/ui";
import { getT } from "@/i18n";
import { getUser, isStaff, safeNext } from "@/lib/auth";
import { ensureInstalled } from "@/lib/install";
import { getSettings } from "@/lib/settings";
import { PasskeySignIn } from "@/components/passkey-buttons";
import { login } from "../actions";

export const metadata = { title: "Sign in" };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string; reset?: string }> }) {
  await ensureInstalled();
  const { next, reset } = await searchParams;
  const user = await getUser();
  if (user) redirect(safeNext(next, isStaff(user) ? "/admin" : "/client"));
  const [t, general] = await Promise.all([getT(), getSettings("general")]);

  return (
    <div className="rounded-xl bg-surface p-6">
      <h1 className="text-center text-[2rem] leading-10 font-normal text-balance">{t("Welcome to {site}!", { site: general.siteName })}</h1>
      <p className="mt-4 mb-7 text-center text-body">{t("Good to see you again.")}</p>
      {reset && (
        <div className="mb-4">
          <Alert tone="success">{t("Password updated. You can now sign in.")}</Alert>
        </div>
      )}
      <ActionForm action={login}>
        <input type="hidden" name="next" value={next ?? ""} />
        <Field label={t("Email")}>
          <Input name="email" type="email" autoComplete="email" placeholder={t("Enter your email")} required autoFocus />
        </Field>
        <Field label={t("Password")}>
          <Input name="password" type="password" autoComplete="current-password" placeholder={t("Enter your password")} required />
        </Field>
        <p className="-mt-1 text-xs">
          <Link href="/forgot-password" className="text-link hover:underline">{t("Forgot your password?")}</Link>
        </p>
        <SubmitButton className="w-full">{t("Sign in")}</SubmitButton>
      </ActionForm>

      <div className="mt-3">
        <PasskeySignIn next={next ?? ""} labels={{ signIn: t("Sign in with a passkey"), add: "", name: "", cancelled: t("Cancelled, or no passkey was chosen."), failed: t("The passkey did not work. Try again.") }} />
      </div>

      <div aria-hidden className="my-7 h-px bg-gradient-to-r from-transparent via-border-strong to-transparent" />

      <div className="space-y-4 text-center text-sm">
        {general.allowRegistration && (
          <p>
            <Link href={`/register${next ? `?next=${encodeURIComponent(next)}` : ""}`} className="text-link hover:underline">{t("Create an account")}</Link>
          </p>
        )}
        {general.supportEmail && (
          <p className="text-xs text-muted">
            {t("Need help?")} <a href={`mailto:${general.supportEmail}`} className="text-link hover:underline">{general.supportEmail}</a>
          </p>
        )}
      </div>
    </div>
  );
}
