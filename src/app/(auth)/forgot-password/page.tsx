import Link from "next/link";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { Alert, Field, Input } from "@/components/ui";
import { getT } from "@/i18n";
import { ensureInstalled } from "@/lib/install";
import { mailConfigured } from "@/lib/mail/transport";
import { getSettings } from "@/lib/settings";
import { forgotPassword } from "../actions";

export const metadata = { title: "Reset password" };

export default async function ForgotPasswordPage() {
  await ensureInstalled();
  const [t, mail] = await Promise.all([getT(), getSettings("mail")]);

  return (
    <div className="rounded-xl bg-surface p-6">
      <h1 className="mb-2 text-center text-[2rem] leading-10 font-normal text-balance">{t("Reset password")}</h1>
      <p className="mt-1 mb-5 text-sm text-muted">{t("Enter your email and we will send you a link to choose a new password.")}</p>
      {mailConfigured(mail) ? (
        <ActionForm action={forgotPassword}>
          <Field label={t("Email")}>
            <Input name="email" type="email" autoComplete="email" required autoFocus />
          </Field>
          <SubmitButton className="w-full">{t("Send reset link")}</SubmitButton>
        </ActionForm>
      ) : (
        <Alert tone="warning">{t("Password reset by email is not available. Please contact support.")}</Alert>
      )}
      <p className="mt-5 text-center text-sm text-muted">
        <Link href="/login" className="text-link hover:underline">
          ← {t("Back to sign in")}
        </Link>
      </p>
    </div>
  );
}
