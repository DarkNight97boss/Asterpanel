import "server-only";
import { cache } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { requireUser, type SessionUser } from "./auth";
import { getImpersonator } from "./impersonation";
import { listAccounts, roleCan, type Account, type Permission } from "./roles";

/**
 * Accounts and teams. Every user owns one account (their services, invoices,
 * tickets). Owners can invite other users into it with a role; a member then
 * switches between "their" accounts from the top bar. All client-area data is
 * scoped by the *active account*, never directly by the signed-in user.
 */

export const ACCOUNT_COOKIE = "aster_account";
export { listAccounts, mayAccess, ROLE_LABEL, roleCan, type Account, type AccountRole, type Permission } from "./roles";

export const getAccount = cache(async (): Promise<{ user: SessionUser; account: Account; accounts: Account[] }> => {
  const user = await requireUser();
  const accounts = await listAccounts(user);
  const wanted = (await cookies()).get(ACCOUNT_COOKIE)?.value;
  // The cookie is only a preference: membership is re-checked on every request.
  return { user, accounts, account: accounts.find((a) => a.id === wanted) ?? accounts[0] };
});

/** A company can require 2FA: members without it can only reach their profile, where it is set up. Staff acting as a client are exempt. */
export function enforceTwoFactor(ctx: { user: SessionUser; account: Account }) {
  if (ctx.account.require2fa && !ctx.user.totpEnabledAt) redirect("/client/profile?need2fa=1");
}

/** Active account, or a redirect to the dashboard when the role does not allow `permission`. */
export async function requireAccount(permission: Permission = "support") {
  const ctx = await getAccount();
  if (!(await getImpersonator())) enforceTwoFactor(ctx);
  if (!roleCan(ctx.account.role, permission)) redirect("/client?denied=1");
  return { ...ctx, can: (p: Permission) => roleCan(ctx.account.role, p) };
}
