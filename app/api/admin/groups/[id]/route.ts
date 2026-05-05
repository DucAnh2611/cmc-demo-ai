import '@/lib/envGuard';
import { NextRequest } from 'next/server';
import { checkAdmin } from '@/lib/admin/requireAdmin';
import {
  getGroup,
  getGroupMembers,
  updateGroup,
  deleteGroup,
  GraphError,
  type UpdateGroupInput
} from '@/lib/admin/graph';
import { auditLog } from '@/lib/audit/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/admin/groups/[id]
 *
 * Detail view for one group — basic fields plus its direct members
 * (users only, no nested groups or service principals). Members list is
 * what admins reach for most often during demo prep.
 */
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await checkAdmin(req);
  if (!auth.ok) return new Response(auth.message, { status: auth.status });

  try {
    const [group, members] = await Promise.all([
      getGroup(auth.token, params.id),
      getGroupMembers(auth.token, params.id)
    ]);
    const adminGroupId = (process.env.GROUP_APP_ADMINS_ID || '').trim();
    const uploadersGroupId = (process.env.GROUP_UPLOADERS_ID || '').trim();
    const annotated = {
      ...group,
      isAppAdminGroup: !!adminGroupId && group.id === adminGroupId,
      isUploadersGroup: !!uploadersGroupId && group.id === uploadersGroupId
    };
    return Response.json({ group: annotated, members });
  } catch (e) {
    if (e instanceof GraphError) {
      return new Response(e.message, { status: e.status });
    }
    return new Response(`Unexpected: ${(e as Error).message}`, { status: 500 });
  }
}

/**
 * PATCH /api/admin/groups/[id] — partial update.
 *
 * Body: { displayName?, description? }. Only non-undefined keys forwarded.
 */
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await checkAdmin(req);
  if (!auth.ok) return new Response(auth.message, { status: auth.status });

  let body: Partial<UpdateGroupInput>;
  try {
    body = (await req.json()) as Partial<UpdateGroupInput>;
  } catch {
    return new Response('Body must be valid JSON', { status: 400 });
  }
  const ALLOWED = ['displayName', 'description'] as const;
  const patch: UpdateGroupInput = {};
  for (const k of ALLOWED) {
    if (body[k] !== undefined) (patch as Record<string, unknown>)[k] = body[k];
  }
  if (Object.keys(patch).length === 0) {
    return new Response('No updatable fields. Allowed: displayName, description.', { status: 400 });
  }

  try {
    await updateGroup(auth.token, params.id, patch);
    await auditLog({
      userId: auth.user.oid,
      upn: auth.user.upn,
      query: `[admin:update-group] ${params.id}`,
      retrievedDocIds: [params.id],
      retrievedTitles: [],
      responsePreview: `Admin ${auth.user.upn || auth.user.oid} updated group ${params.id}; fields=${Object.keys(patch).join(',')}`,
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
 * DELETE /api/admin/groups/[id]
 *
 * Refuses to delete the group named in GROUP_APP_ADMINS_ID — that's the
 * admin gate; deleting it would lock everyone out of /admin. Same idea
 * for GROUP_UPLOADERS_ID. Both checks are belt-and-braces — Graph would
 * still let it through.
 */
export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await checkAdmin(req);
  if (!auth.ok) return new Response(auth.message, { status: auth.status });

  const adminGroupId = (process.env.GROUP_APP_ADMINS_ID || '').trim();
  const uploadersGroupId = (process.env.GROUP_UPLOADERS_ID || '').trim();
  if (adminGroupId && params.id === adminGroupId) {
    return new Response(
      'Refusing to delete the GROUP_APP_ADMINS_ID group — would lock everyone out of /admin. Remove the env var first if you really need to.',
      { status: 400 }
    );
  }
  if (uploadersGroupId && params.id === uploadersGroupId) {
    return new Response(
      'Refusing to delete the GROUP_UPLOADERS_ID group — would break uploads. Remove the env var first if you really need to.',
      { status: 400 }
    );
  }

  let nameForAudit = params.id;
  try {
    const g = await getGroup(auth.token, params.id);
    nameForAudit = g.displayName;
  } catch {
    /* not fatal */
  }

  try {
    await deleteGroup(auth.token, params.id);
    await auditLog({
      userId: auth.user.oid,
      upn: auth.user.upn,
      query: `[admin:delete-group] ${nameForAudit}`,
      retrievedDocIds: [params.id],
      retrievedTitles: [nameForAudit],
      responsePreview: `Admin ${auth.user.upn || auth.user.oid} soft-deleted group "${nameForAudit}" (${params.id}); recoverable 30d via Azure portal`,
      groupCount: auth.groups.length,
      timestamp: new Date().toISOString()
    }).catch(() => {});
    return new Response(null, { status: 204 });
  } catch (e) {
    if (e instanceof GraphError) return new Response(e.message, { status: e.status });
    return new Response(`Unexpected: ${(e as Error).message}`, { status: 500 });
  }
}
