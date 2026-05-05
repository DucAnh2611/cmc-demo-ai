import '@/lib/envGuard';
import { NextRequest } from 'next/server';
import { checkAdmin } from '@/lib/admin/requireAdmin';
import { addGroupMember, removeGroupMember, GraphError } from '@/lib/admin/graph';
import { getUserProtection } from '@/lib/admin/protection';
import { auditLog } from '@/lib/audit/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/admin/groups/[id]/members
 * Body: { userId: string }
 *
 * Adds the user as a direct member of the group.
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await checkAdmin(req);
  if (!auth.ok) return new Response(auth.message, { status: auth.status });

  let body: { userId?: string };
  try {
    body = (await req.json()) as { userId?: string };
  } catch {
    return new Response('Body must be valid JSON', { status: 400 });
  }
  const userId = (body.userId || '').trim();
  if (!userId) return new Response('userId is required', { status: 400 });

  // Hard-block adding users to the in-app admin group from this panel.
  // Admin elevation is a tenant-administrator decision and must happen
  // out-of-band (Azure portal, IAM workflow, ticket, etc.) — NOT through
  // the same UI that any current admin can click in. This stops a
  // compromised admin session from quietly seeding new admins.
  const adminGroupId = (process.env.GROUP_APP_ADMINS_ID || '').trim();
  if (adminGroupId && params.id === adminGroupId) {
    return new Response(
      'Refusing to add a user to the app-admins group from the in-app panel. ' +
        'Admin elevation must happen in Azure portal — go to Microsoft Entra ID → Groups → ' +
        'this group → Members → + Add members.',
      { status: 400 }
    );
  }

  // Protected users (admin-group members + #EXT# system accounts) are
  // view-only in this panel — group memberships included.
  const prot = await getUserProtection(auth.token, userId);
  if (prot.isAppAdmin || prot.isSystemAccount) {
    return new Response(
      `Refusing to add a ${prot.isAppAdmin ? 'app-admins group member' : 'system / external account'} (${prot.upn}) to a group. ` +
        'These users are view-only in this panel — manage their group memberships in Azure portal directly.',
      { status: 400 }
    );
  }

  try {
    await addGroupMember(auth.token, params.id, userId);
    await auditLog({
      userId: auth.user.oid,
      upn: auth.user.upn,
      query: `[admin:add-member] ${userId} → group ${params.id}`,
      retrievedDocIds: [userId, params.id],
      retrievedTitles: [],
      responsePreview: `Admin ${auth.user.upn || auth.user.oid} added user ${userId} to group ${params.id}`,
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
 * DELETE /api/admin/groups/[id]/members?userId=<oid>
 *
 * Removes the user from the group. Refuses to remove the LAST admin
 * from GROUP_APP_ADMINS_ID — would lock everyone out of /admin.
 */
export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await checkAdmin(req);
  if (!auth.ok) return new Response(auth.message, { status: auth.status });

  const url = new URL(req.url);
  const userId = (url.searchParams.get('userId') || '').trim();
  if (!userId) return new Response('userId query param is required', { status: 400 });

  // Guard against self-removal from the admin group → would 403 the
  // caller out of the admin panel mid-session. Other admins can do this
  // for them via Azure portal.
  const adminGroupId = (process.env.GROUP_APP_ADMINS_ID || '').trim();
  if (adminGroupId && params.id === adminGroupId && userId === auth.user.oid) {
    return new Response(
      'Refusing to remove yourself from the admin group — you would lose access immediately. Ask another admin.',
      { status: 400 }
    );
  }

  // Protected users (admin-group members + #EXT# system accounts) are
  // view-only — group churn for them must happen in Azure portal.
  const prot = await getUserProtection(auth.token, userId);
  if (prot.isAppAdmin || prot.isSystemAccount) {
    return new Response(
      `Refusing to remove a ${prot.isAppAdmin ? 'app-admins group member' : 'system / external account'} (${prot.upn}) from a group. ` +
        'These users are view-only in this panel — manage their group memberships in Azure portal directly.',
      { status: 400 }
    );
  }

  try {
    await removeGroupMember(auth.token, params.id, userId);
    await auditLog({
      userId: auth.user.oid,
      upn: auth.user.upn,
      query: `[admin:remove-member] ${userId} ← group ${params.id}`,
      retrievedDocIds: [userId, params.id],
      retrievedTitles: [],
      responsePreview: `Admin ${auth.user.upn || auth.user.oid} removed user ${userId} from group ${params.id}`,
      groupCount: auth.groups.length,
      timestamp: new Date().toISOString()
    }).catch(() => {});
    return new Response(null, { status: 204 });
  } catch (e) {
    if (e instanceof GraphError) return new Response(e.message, { status: e.status });
    return new Response(`Unexpected: ${(e as Error).message}`, { status: 500 });
  }
}
