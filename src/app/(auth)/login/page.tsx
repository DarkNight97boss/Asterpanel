import Link from "next/link";
import { redirect } from "next/navigation";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { Card, Field, Input } from "@/components/ui";
import { getT } from "@/i18n";
import { getUser, isStaff, safeNext } from "@/lib/auth";
import { ensureInstalled } from "@/lib/install";
import { getSettings } from "@/lib/settings";
import { login } from "../actions";

export const metadata = { title: "Sign in" };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  await ensureInstalled();
  const { next } = await searchParams;
  const user = await getUser();
  if (user) redirect(safeNext(next, isStaff(user) ? "/admin" : "/client"));
  const [t, general] = await Promise.all([getT(), getSettings("general")]);

  return (
    <Card className="p-6">
      <h1 className="text-xl font-bold">{t("Sign in")}</h1>
      <p className="mt-1 mb-5 text-sm text-muted">{t("Access your services, invoices and support.")}</p>
      <ActionForm action={login}>
        <input type="hidden" name="next" value={next ?? ""} />
        <Field label={t("Email")}>
          <Input name="email" type="email" autoComplete="email" required autoFocus />
        </Field>
        <Field label={t("Password")}>
          <Input name="password" type="password" autoComplete="current-password" required />
        </Field>
        <SubmitButton className="w-full">{t("Sign in")}</SubmitButton>
      </ActionForm>
      {general.allowRegistration && (
        <p className="mt-5 text-center text-sm text-muted">
          {t("New here?")}{" "}
          <Link href={`/register${next ? `?next=${encodeURIComponent(next)}` : ""}`} className="font-medium text-primary">
            {t("Create an account")}
          </Link>
        </p>
      )}
    </Card>
  );
}
