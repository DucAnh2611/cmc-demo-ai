import { NextRequest } from 'next/server';
import { verifyAccessToken, type VerifiedToken } from '@/lib/auth/verifyToken';
import { getUserGroups } from '@/lib/auth/getUserGroups';

/**
 * Result of the admin-auth check.
 *
 * `ok: false` carries an HTTP status + human-readable message that the
 * route handler can convert directly to a Response. We deliberately
 * return rather than throw so each route stays a flat sequence of checks
 * — easier to read and to test.
 */
export type AdminAuthResult =
  | { ok: true; user: VerifiedToken; groups: string[]; token: string }
  | { ok: false; status: number; message: string };

/**
 * Gate every /api/admin/* endpoint and the /admin page on:
 *   1. Valid bearer token (auth)
 *   2. Caller is a member of the group named in GROUP_APP_ADMINS_ID
 *      (authorisation — separate from GROUP_UPLOADERS_ID; identity
 *      management is a different blast radius from doc moderation)
 *
 * If GROUP_APP_ADMINS_ID is unset, the admin feature is disabled with
 * a 503 — explicit "not configured" beats "anyone can do this".
 *
 * Token is returned alongside the verified user so downstream Graph
 * helpers can re-use it (delegated permission flow — Graph enforces
 * Entra RBAC on top of OAuth scopes, so the SIGNED-IN user must also
 * hold an Entra role like "User Administrator" for any write call to
 * succeed; this gate doesn't replace that, it adds an in-app layer).
 */
export async function checkAdmin(req: NextRequest): Promise<AdminAuthResult> {
  const auth = req.headers.get('authorization') || '';
  const m = /^Bearer (.+)$/.exec(auth);
  if (!m) return { ok: false, status: 401, message: 'Missing bearer token' };
  const token = m[1];

  let user: VerifiedToken;
  try {
    user = await verifyAccessToken(token);
  } catch (e) {
    return { ok: false, status: 401, message: `Invalid token: ${(e as Error).message}` };
  }

  const adminGroup = (process.env.GROUP_APP_ADMINS_ID || '').trim();
  if (!adminGroup) {
    return {
      ok: false,
      status: 503,
      message:
        'Admin panel is disabled — set GROUP_APP_ADMINS_ID in .env.local to a security group whose members may manage users + groups.'
    };
  }

  const groups = await getUserGroups(token);
  if (!groups.includes(adminGroup)) {
    return {
      ok: false,
      status: 403,
      message:
        'Your account is not a member of the app-admins group. Ask a tenant admin to add you.'
    };
  }

  return { ok: true, user, groups, token };
}
