import '@/lib/envGuard';
import { NextRequest } from 'next/server';
import { verifyAccessToken } from '@/lib/auth/verifyToken';
import { getUserGroups } from '@/lib/auth/getUserGroups';
import { isAppAdmin } from '@/lib/admin/isAppAdmin';
import { loadFlowAccess, checkFlowAccess } from '@/lib/security/flowAccess';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/flow-access/check?t=<shareToken>
 *
 * Public endpoint — does NOT require a bearer token. The /flow page's
 * client-side gate calls this to find out whether to render the doc,
 * prompt for sign-in, or show a denial state.
 *
 * The `t` query param is the share token used by `anyone-with-link`
 * mode. It's ignored in other modes.
 *
 * Behaviour:
 *   - `public` mode: granted unconditionally. No auth check.
 *   - `anyone-with-link` mode: granted only when `?t=<token>` matches
 *     the policy's stored linkToken. Without (or wrong) token →
 *     `invalid-link`.
 *   - `restricted` mode: caller's bearer token is validated; granted
 *     when their oid or one of their groups matches the allowlist.
 *     Unsigned → `sign-in-required`.
 *
 * Admins always pass. The endpoint also returns the FULL policy
 * (including `linkToken`) to admins so the inline editor can show the
 * shareable URL; non-admins see only the mode.
 */
export async function GET(req: NextRequest) {
  const policy = await loadFlowAccess();
  const url = new URL(req.url);
  const shareToken = url.searchParams.get('t') || '';

  // Try to resolve identity from the bearer token. Failure is fine —
  // open modes (public, anyone-with-link + correct token) don't need it.
  const auth = req.headers.get('authorization') || '';
  const match = /^Bearer (.+)$/.exec(auth);
  let oid: string | undefined;
  let groups: string[] = [];
  let admin = false;
  if (match) {
    try {
      const user = await verifyAccessToken(match[1]);
      oid = user.oid;
      groups = await getUserGroups(match[1]);
      admin = isAppAdmin(groups);
    } catch {
      /* invalid token — treat as unsigned */
    }
  }

  const decision = checkFlowAccess(policy, {
    oid,
    groupIds: groups,
    isAdmin: admin,
    shareToken
  });

  return Response.json({
    decision,
    // Admins see the full policy (including the linkToken so they can
    // copy the share URL). Everyone else sees just the mode.
    policy: admin ? policy : { mode: policy.mode },
    isAdmin: admin
  });
}
