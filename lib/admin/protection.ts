import { getUser, getUserGroupsAdmin } from '@/lib/admin/graph';

/**
 * Per-user "is this user mutation-protected from this panel?" check.
 *
 * Two protection signals — either is enough to block any modification
 * (PATCH, password reset, group add/remove). The matching server-side
 * routes call this; the frontend reads the same flags off the GET
 * response and hides action buttons.
 *
 *   isAppAdmin     — target is in GROUP_APP_ADMINS_ID. Admin churn is
 *                    a tenant-level decision and must happen in Azure
 *                    portal directly.
 *   isSystemAccount — target's UPN contains the synthetic-account
 *                    marker `#EXT#`. Catches the tenant owner (a
 *                    Microsoft consumer account that signed up for
 *                    the tenant gets a UPN like
 *                    `name_gmail.com#EXT#@tenant.onmicrosoft.com`)
 *                    AND any B2B guest. These accounts are managed
 *                    in their home tenant or via Azure portal — not
 *                    here, where deleting / renaming / resetting
 *                    risks orphaning sharing or breaking the tenant.
 *
 * Returns the upn so the caller can put it in audit / error messages.
 * If the underlying Graph reads fail we conservatively return
 * `unknown: true` and let the caller decide whether to fail-open or
 * fail-closed (most callers fail-closed: reject on unknown).
 */
export interface UserProtectionInfo {
  upn: string;
  isAppAdmin: boolean;
  isSystemAccount: boolean;
  /** True when we couldn't determine protection (Graph error). */
  unknown: boolean;
}

export async function getUserProtection(
  token: string,
  userId: string
): Promise<UserProtectionInfo> {
  const adminGroupId = (process.env.GROUP_APP_ADMINS_ID || '').trim();
  let upn = userId;
  let isSystemAccount = false;
  let isAppAdmin = false;
  let unknown = false;

  try {
    // Run both reads in parallel — they're independent.
    const [user, groups] = await Promise.all([
      getUser(token, userId),
      adminGroupId ? getUserGroupsAdmin(token, userId) : Promise.resolve([])
    ]);
    upn = user.userPrincipalName || userId;
    isSystemAccount = upn.includes('#EXT#');
    isAppAdmin = !!adminGroupId && groups.some((g) => g.id === adminGroupId);
  } catch {
    unknown = true;
  }

  return { upn, isAppAdmin, isSystemAccount, unknown };
}
