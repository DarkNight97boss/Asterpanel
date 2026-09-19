import Link from "next/link";
import { redirect } from "next/navigation";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { Alert, Field, Input } from "@/components/ui";
import { getT } from "@/i18n";
import { getUser, safeNext } from "@/lib/auth";
import { ensureInstalled } from "@/lib/install";
import { getSettings } from "@/lib/settings";
import { register } from "../actions";

export const metadata = { title: "Create an account" };

export default async function RegisterPage({ searchParams }: { searchParams: Promise<{ next?: string; ref?: string }> }) {
  await ensureInstalled();
  const { next, ref } = await searchParams;
  if (await getUser()) redirect(safeNext(next, "/client"));
  const [t, general] = await Promise.all([getT(), getSettings("general")]);

  return (
    <div className="rounded-xl bg-surface p-6">
      <h1 className="mb-2 text-center text-[2rem] leading-10 font-normal text-balance">{t("Create an account")}</h1>
      {general.allowRegistration ? (
        <ActionForm action={register}>
          <input type="hidden" name="next" value={next ?? ""} />
          <input type="hidden" name="referralCode" value={/^[A-Za-z0-9]{6,12}$/.test(ref ?? "") ? ref : ""} />
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t("First name")}>
              <Input name="firstName" autoComplete="given-name" required />
            </Field>
            <Field label={t("Last name")}>
              <Input name="lastName" autoComplete="family-name" required />
            </Field>
          </div>
          <Field label={t("Company (optional)")}>
            <Input name="company" autoComplete="organization" />
          </Field>
          <Field label={t("Email")}>
            <Input name="email" type="email" autoComplete="email" required />
          </Field>
          <Field label={t("Password")} hint={t("At least 10 characters.")}>
            <Input name="password" type="password" autoComplete="new-password" minLength={10} required />
          </Field>
          <SubmitButton className="w-full">{t("Create account")}</SubmitButton>
        </ActionForm>
      ) : (
        <Alert tone="warning">{t("Registration is disabled")}</Alert>
      )}
      <p className="mt-5 text-center text-sm text-muted">
        {t("Already have an account?")}{" "}
        <Link href={`/login${next ? `?next=${encodeURIComponent(next)}` : ""}`} className="text-link hover:underline">
          {t("Sign in")}
        </Link>
      </p>
    </div>
  );
}
