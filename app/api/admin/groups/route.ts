import '@/lib/envGuard';
import { NextRequest } from 'next/server';
import { checkAdmin } from '@/lib/admin/requireAdmin';
import { listGroups, createGroup, GraphError, type CreateGroupInput } from '@/lib/admin/graph';
import { auditLog } from '@/lib/audit/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/admin/groups
 *
 * List Security groups in the tenant (the only kind that drives RAG
 * ACL — Microsoft 365 / Unified groups are excluded by the listGroups
 * filter). Includes nothing destructive.
 */
export async function GET(req: NextRequest) {
  const auth = await checkAdmin(req);
  if (!auth.ok) return new Response(auth.message, { status: auth.status });

  try {
    const groups = await listGroups(auth.token);
    // Mark the special "permission" groups so the UI can disable
    // membership editing on them (admin elevation must happen in Azure
    // portal, not in this panel — see the POST /members guard).
    const adminGroupId = (process.env.GROUP_APP_ADMINS_ID || '').trim();
    const uploadersGroupId = (process.env.GROUP_UPLOADERS_ID || '').trim();
    const annotated = groups.map((g) => ({
      ...g,
      isAppAdminGroup: !!adminGroupId && g.id === adminGroupId,
      isUploadersGroup: !!uploadersGroupId && g.id === uploadersGroupId
    }));
    return Response.json({ groups: annotated, count: annotated.length });
  } catch (e) {
    if (e instanceof GraphError) {
      return new Response(e.message, { status: e.status });
    }
    return new Response(`Unexpected: ${(e as Error).message}`, { status: 500 });
  }
}

/**
 * POST /api/admin/groups — create a Security group.
 *
 * Body: { displayName, description?, mailNickname? }
 *
 * Forces securityEnabled / mailEnabled / groupTypes settings — see
 * createGroup() in lib/admin/graph for why.
 */
export async function POST(req: NextRequest) {
  const auth = await checkAdmin(req);
  if (!auth.ok) return new Response(auth.message, { status: auth.status });

  let body: Partial<CreateGroupInput>;
  try {
    body = (await req.json()) as Partial<CreateGroupInput>;
  } catch {
    return new Response('Body must be valid JSON', { status: 400 });
  }
  if (!body.displayName || typeof body.displayName !== 'string') {
    return new Response('displayName is required', { status: 400 });
  }

  try {
    const created = await createGroup(auth.token, body as CreateGroupInput);
    await auditLog({
      userId: auth.user.oid,
      upn: auth.user.upn,
      query: `[admin:create-group] ${created.displayName}`,
      retrievedDocIds: [created.id],
      retrievedTitles: [created.displayName],
      responsePreview: `Admin ${auth.user.upn || auth.user.oid} created group "${created.displayName}" (${created.id})`,
      groupCount: auth.groups.length,
      timestamp: new Date().toISOString()
    }).catch(() => {});
    return Response.json({ group: created }, { status: 201 });
  } catch (e) {
    if (e instanceof GraphError) return new Response(e.message, { status: e.status });
    return new Response(`Unexpected: ${(e as Error).message}`, { status: 500 });
  }
}
