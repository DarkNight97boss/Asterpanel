import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { Alert, buttonClass } from "@/components/ui";
import { getT } from "@/i18n";
import { ACCOUNT_COOKIE, ROLE_LABEL } from "@/lib/account";
import { getUser } from "@/lib/auth";
import { ensureInstalled } from "@/lib/install";
import { acceptInvite, findInvite, TeamError } from "@/lib/team";

export const metadata = { title: "Team invitation", referrer: "no-referrer", robots: { index: false } };

export default async function InvitePage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  await ensureInstalled();
  const token = (await searchParams).token ?? "";
  const [t, found, user] = await Promise.all([getT(), findInvite(token), getUser()]);
  const here = `/invite?token=${encodeURIComponent(token)}`;

  async function accept() {
    "use server";
    const me = await getUser();
    if (!me) redirect(`/login?next=${encodeURIComponent(here)}`);
    let companyId: string;
    try {
      companyId = await acceptInvite(token, me);
    } catch (err) {
      if (err instanceof TeamError) redirect(here);
      throw err;
    }
    (await cookies()).set(ACCOUNT_COOKIE, companyId, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/", maxAge: 60 * 60 * 24 * 365 });
    redirect("/client");
  }

  return (
    <div className="rounded-xl bg-surface p-6 text-center">
      <h1 className="mb-4 text-[2rem] leading-10 font-normal text-balance">{t("Team invitation")}</h1>
      {!found ? (
        <Alert tone="danger">{t("This invitation is invalid or has expired")}</Alert>
      ) : (
        <>
          <p className="mb-6 text-body">
            {t("You have been invited to help manage {account} as {role}.", { account: found.company.name, role: t(ROLE_LABEL[found.invite.role]) })}
          </p>
          {!user ? (
            <div className="space-y-3">
              <Link href={`/login?next=${encodeURIComponent(here)}`} className={buttonClass("primary", "md", "w-full")}>{t("Sign in")}</Link>
              <Link href={`/register?next=${encodeURIComponent(here)}`} className={buttonClass("secondary", "md", "w-full")}>{t("Create an account")}</Link>
              <p className="text-xs text-muted">{t("Use the address the invitation was sent to: {email}", { email: found.invite.email })}</p>
            </div>
          ) : user.email !== found.invite.email ? (
            <Alert tone="warning">{t("You are signed in as {me}, but this invitation is for {email}. Sign in with that address to accept it.", { me: user.email, email: found.invite.email })}</Alert>
          ) : (
            <form action={accept}>
              <button className={buttonClass("primary", "md", "w-full")}>{t("Accept invitation")}</button>
            </form>
          )}
        </>
      )}
    </div>
  );
}
