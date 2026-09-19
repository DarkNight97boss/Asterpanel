import Link from "next/link";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { Alert, Field, Input } from "@/components/ui";
import { getT } from "@/i18n";
import { ensureInstalled } from "@/lib/install";
import { resetTokenIsValid } from "@/lib/password-reset";
import { completePasswordReset } from "../actions";

// The token is in the URL: keep it out of Referer headers and search indexes.
export const metadata = { title: "Choose a new password", referrer: "no-referrer", robots: { index: false } };

export default async function ResetPasswordPage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  await ensureInstalled();
  const token = (await searchParams).token ?? "";
  const [t, valid] = await Promise.all([getT(), resetTokenIsValid(token)]);

  return (
    <div className="rounded-xl bg-surface p-6">
      <h1 className="mb-2 text-center text-[2rem] leading-10 font-normal text-balance">{t("Choose a new password")}</h1>
      {valid ? (
        <ActionForm action={completePasswordReset}>
          <input type="hidden" name="token" value={token} />
          <Field label={t("New password")} hint={t("At least 10 characters.")}>
            <Input name="password" type="password" autoComplete="new-password" minLength={10} required autoFocus />
          </Field>
          <SubmitButton className="w-full">{t("Update password")}</SubmitButton>
        </ActionForm>
      ) : (
        <>
          <Alert tone="danger">{t("This link is invalid or has expired. Request a new one.")}</Alert>
          <p className="mt-5 text-center text-sm">
            <Link href="/forgot-password" className="text-link hover:underline">
              {t("Request a new link")}
            </Link>
          </p>
        </>
      )}
    </div>
  );
}
