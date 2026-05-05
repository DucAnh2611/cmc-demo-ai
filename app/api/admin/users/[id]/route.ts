import '@/lib/envGuard';
import { NextRequest } from 'next/server';
import { checkAdmin } from '@/lib/admin/requireAdmin';
import {
  getUser,
  getUserGroupsAdmin,
  updateUser,
  deleteUser,
  GraphError,
  type UpdateUserInput
} from '@/lib/admin/graph';
import { getUserProtection } from '@/lib/admin/protection';
import { auditLog } from '@/lib/audit/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/admin/users/[id]
 *
 * Detail view for one user — basic identity fields plus their resolved
 * group membership (transitive). The group list is the bit that's hard
 * to see at a glance in the Azure portal, so we surface it here.
 */
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await checkAdmin(req);
  if (!auth.ok) return new Response(auth.message, { status: auth.status });

  try {
    // Run user + groups in parallel — both reads, independent.
    const [user, groups] = await Promise.all([
      getUser(auth.token, params.id),
      getUserGroupsAdmin(auth.token, params.id)
    ]);
    // Two protection signals — both drive the UI's Delete-button gate
    // and are re-enforced on the DELETE handler below:
    //
    //   isAppAdmin     — target is in GROUP_APP_ADMINS_ID. Admin churn
    //                    must happen in Azure portal.
    //   isSystemAccount — target's UPN contains the synthetic-account
    //                    marker `#EXT#`. This catches the tenant owner
    //                    (a Microsoft consumer account that signed up
    //                    for the tenant gets a UPN like
    //                    `name_gmail.com#EXT#@tenant.onmicrosoft.com`)
    //                    AND any B2B guest. Deleting either via this
    //                    panel risks orphaning the tenant or breaking
    //                    inbound sharing — too high-blast-radius for
    //                    a self-serve admin tool.
    const adminGroupId = (process.env.GROUP_APP_ADMINS_ID || '').trim();
    const isAppAdmin = !!adminGroupId && groups.some((g) => g.id === adminGroupId);
    const isSystemAccount = (user.userPrincipalName || '').includes('#EXT#');
    return Response.json({
      user: { ...user, isAppAdmin, isSystemAccount },
      groups
    });
  } catch (e) {
    if (e instanceof GraphError) {
      return new Response(e.message, { status: e.status });
    }
    return new Response(`Unexpected: ${(e as Error).message}`, { status: 500 });
  }
}

/**
 * PATCH /api/admin/users/[id] — partial update.
 *
 * Body: { displayName?, jobTitle?, accountEnabled? }
 *
 * Only non-undefined keys are forwarded to Graph. Returns 204.
 */
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await checkAdmin(req);
  if (!auth.ok) return new Response(auth.message, { status: auth.status });

  let body: Partial<UpdateUserInput>;
  try {
    body = (await req.json()) as Partial<UpdateUserInput>;
  } catch {
    return new Response('Body must be valid JSON', { status: 400 });
  }

  const ALLOWED = ['displayName', 'jobTitle', 'accountEnabled'] as const;
  const patch: UpdateUserInput = {};
  for (const k of ALLOWED) {
    if (body[k] !== undefined) (patch as Record<string, unknown>)[k] = body[k];
  }
  if (Object.keys(patch).length === 0) {
    return new Response('No updatable fields in body. Allowed: displayName, jobTitle, accountEnabled.', { status: 400 });
  }

  // Protected users (admin-group members + #EXT# system accounts) are
  // VIEW-ONLY in this panel — any modification must happen in Azure
  // portal. The frontend hides Edit on these users; this is the
  // defence-in-depth gate.
  const prot = await getUserProtection(auth.token, params.id);
  if (prot.isAppAdmin || prot.isSystemAccount) {
    return new Response(
      `Refusing to edit a ${prot.isAppAdmin ? 'app-admins group member' : 'system / external account'} (${prot.upn}). ` +
        'These users are view-only in this panel — manage them in Azure portal directly.',
      { status: 400 }
    );
  }

  try {
    await updateUser(auth.token, params.id, patch);
    await auditLog({
      userId: auth.user.oid,
      upn: auth.user.upn,
      query: `[admin:update-user] ${params.id}`,
      retrievedDocIds: [],
      retrievedTitles: [],
      responsePreview: `Admin ${auth.user.upn || auth.user.oid} updated user ${params.id}; fields=${Object.keys(patch).join(',')}`,
      groupCount: auth.groups.length,
      timestamp: new Date().toISOString()
    }).catch(() => {});
    return new Response(null, { status: 204 });
  } catch (e) {
    if (e instanceof GraphError) return new Response(e.message, { status: e.status });
    return new Response(`Unexpected: ${(e as Error).message}`, { status: 500 });
  }
}

/**
 * DELETE /api/admin/users/[id]
 *
 * Microsoft Graph soft-deletes — the user lands in the Deleted Users
 * blade and is recoverable for 30 days. Audit logged.
 */
export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await checkAdmin(req);
  if (!auth.ok) return new Response(auth.message, { status: auth.status });

  // Self-delete guard — refuse to let an admin delete their OWN account.
  // Avoids a "locked out of own panel" footgun. Other admins can still
  // do it via Azure portal if absolutely needed.
  if (params.id === auth.user.oid) {
    return new Response(
      'Refusing to delete your own account. Ask another admin, or use Azure portal.',
      { status: 400 }
    );
  }

  // Best-effort: read the user first. We need the UPN both for the
  // audit message AND for the system-account guard below (system
  // accounts are identified by the `#EXT#` marker in their UPN).
  let upnForAudit = params.id;
  try {
    const u = await getUser(auth.token, params.id);
    upnForAudit = u.userPrincipalName;
    // System-account guard — refuse to delete a tenant-owner / B2B
    // guest UPN. Microsoft uses the `#EXT#` infix in synthetic UPNs
    // for any account whose identity lives in another tenant (consumer
    // Microsoft accounts that created the tenant, B2B invitees, etc.).
    // Deleting these via the panel risks orphaning the tenant or
    // breaking inbound sharing.
    if ((u.userPrincipalName || '').includes('#EXT#')) {
      return new Response(
        `Refusing to delete a system / external account (${u.userPrincipalName}). ` +
          'These accounts (tenant owner, B2B guests) must be managed in Azure portal — ' +
          'use Microsoft Entra ID → Users → this user → Delete.',
        { status: 400 }
      );
    }
  } catch {
    /* not fatal — fall through to the admin-group + delete path */
  }

  // Admin-protection guard — refuse to delete anyone in the in-app
  // admin group from this panel. Admin churn is a tenant-level decision
  // and must happen in Azure portal directly. Without this, an admin
  // could quietly nuke other admins through the same UI they use for
  // routine user management.
  const adminGroupId = (process.env.GROUP_APP_ADMINS_ID || '').trim();
  if (adminGroupId) {
    try {
      const targetGroups = await getUserGroupsAdmin(auth.token, params.id);
      if (targetGroups.some((g) => g.id === adminGroupId)) {
        return new Response(
          'Refusing to delete a member of the app-admins group from this panel. ' +
            'Remove them from the admin group in Azure portal first, then delete.',
          { status: 400 }
        );
      }
    } catch {
      // Couldn't read the target's groups — fall through. Better to
      // proceed with the delete and let Graph reject if there's a real
      // permission issue than to refuse on a transient read failure.
    }
  }

  try {
    await deleteUser(auth.token, params.id);
    await auditLog({
      userId: auth.user.oid,
      upn: auth.user.upn,
      query: `[admin:delete-user] ${upnForAudit}`,
      retrievedDocIds: [params.id],
      retrievedTitles: [upnForAudit],
      responsePreview: `Admin ${auth.user.upn || auth.user.oid} soft-deleted user ${upnForAudit} (${params.id}); recoverable 30d via Azure portal`,
      groupCount: auth.groups.length,
      timestamp: new Date().toISOString()
    }).catch(() => {});
    return new Response(null, { status: 204 });
  } catch (e) {
    if (e instanceof GraphError) return new Response(e.message, { status: e.status });
    return new Response(`Unexpected: ${(e as Error).message}`, { status: 500 });
  }
}
