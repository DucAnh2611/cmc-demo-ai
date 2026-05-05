import '@/lib/envGuard';
import { NextRequest } from 'next/server';
import { checkAdmin } from '@/lib/admin/requireAdmin';
import { resetUserPassword, getUser, GraphError } from '@/lib/admin/graph';
import { getUserProtection } from '@/lib/admin/protection';
import { auditLog } from '@/lib/audit/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/admin/users/[id]/password
 *
 * Reset another user's password. Body:
 *   { password: string, forceChangePasswordNextSignIn?: boolean }
 *
 * Auth: GROUP_APP_ADMINS_ID member + Graph-side Entra role (User
 * Administrator at minimum). Refuses self-reset (admin should change
 * their own password through the regular MS account flow, not this
 * privileged endpoint — different audit semantics).
 *
 * Audited as a distinct event (`[admin:reset-password]`) so password
 * resets stand out in the audit trail vs. routine PATCH-user updates.
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await checkAdmin(req);
  if (!auth.ok) return new Response(auth.message, { status: auth.status });

  if (params.id === auth.user.oid) {
    return new Response(
      'Refusing to reset your own password from the admin panel — use myaccount.microsoft.com.',
      { status: 400 }
    );
  }

  let body: { password?: string; forceChangePasswordNextSignIn?: boolean };
  try {
    body = (await req.json()) as { password?: string; forceChangePasswordNextSignIn?: boolean };
  } catch {
    return new Response('Body must be valid JSON', { status: 400 });
  }
  if (!body.password || typeof body.password !== 'string' || body.password.length < 8) {
    return new Response('password must be a string of at least 8 characters', { status: 400 });
  }

  // Protected users are view-only — including their password.
  const prot = await getUserProtection(auth.token, params.id);
  if (prot.isAppAdmin || prot.isSystemAccount) {
    return new Response(
      `Refusing to reset the password of a ${prot.isAppAdmin ? 'app-admins group member' : 'system / external account'} (${prot.upn}). ` +
        'These users are view-only in this panel — reset their password in Azure portal directly.',
      { status: 400 }
    );
  }

  // Best-effort: read the user UPN for a friendlier audit message.
  let upnForAudit = params.id;
  try {
    const u = await getUser(auth.token, params.id);
    upnForAudit = u.userPrincipalName;
  } catch {
    /* not fatal */
  }

  try {
    await resetUserPassword(
      auth.token,
      params.id,
      body.password,
      body.forceChangePasswordNextSignIn ?? true
    );
    await auditLog({
      userId: auth.user.oid,
      upn: auth.user.upn,
      query: `[admin:reset-password] ${upnForAudit}`,
      retrievedDocIds: [params.id],
      retrievedTitles: [upnForAudit],
      // NEVER log the new password value — only that a reset happened.
      responsePreview: `Admin ${auth.user.upn || auth.user.oid} reset password for ${upnForAudit} (${params.id}); forceChange=${body.forceChangePasswordNextSignIn ?? true}`,
      groupCount: auth.groups.length,
      timestamp: new Date().toISOString()
    }).catch(() => {});
    return new Response(null, { status: 204 });
  } catch (e) {
    if (e instanceof GraphError) return new Response(e.message, { status: e.status });
    return new Response(`Unexpected: ${(e as Error).message}`, { status: 500 });
  }
}
