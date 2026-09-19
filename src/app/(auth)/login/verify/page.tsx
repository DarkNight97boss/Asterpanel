import Link from "next/link";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { Field, Input } from "@/components/ui";
import { getT } from "@/i18n";
import { verifyLogin } from "../../actions";

export const metadata = { title: "Two-factor authentication" };

export default async function VerifyLogin({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const [t, { next }] = await Promise.all([getT(), searchParams]);
  return (
    <div className="rounded-xl bg-surface p-6">
      <h1 className="text-center text-[2rem] leading-10 font-normal text-balance">{t("Two-factor authentication")}</h1>
      <p className="mt-4 mb-7 text-center text-body">{t("Enter the 6-digit code from your authenticator app, or one of your recovery codes.")}</p>
      <ActionForm action={verifyLogin}>
        <input type="hidden" name="next" value={next ?? ""} />
        <Field label={t("Code")}>
          <Input name="code" inputMode="numeric" autoComplete="one-time-code" required autoFocus className="text-center text-lg tracking-[0.3em]" maxLength={12} />
        </Field>
        <SubmitButton className="w-full">{t("Verify")}</SubmitButton>
      </ActionForm>
      <p className="mt-6 text-center text-sm"><Link href="/login" className="text-link hover:underline">← {t("Back to sign in")}</Link></p>
    </div>
  );
}
