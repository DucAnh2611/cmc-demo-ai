import '@/lib/envGuard';
import { NextRequest } from 'next/server';
import { checkAdmin } from '@/lib/admin/requireAdmin';
import {
  loadFlowAccess,
  saveFlowAccess,
  type FlowAccessMode,
  type FlowAccessPolicy
} from '@/lib/security/flowAccess';
import { auditLog } from '@/lib/audit/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET   /api/admin/flow-access  — fetch the current policy.
 * PATCH /api/admin/flow-access  — update mode / allowedGroups / allowedUsers.
 *
 * Admin-only. Mutations append an `[admin:update-flow-access]` audit row
 * with the new mode + counts so the SOC can answer "who opened up the
 * docs and when".
 */
export async function GET(req: NextRequest) {
  const auth = await checkAdmin(req);
  if (!auth.ok) return new Response(auth.message, { status: auth.status });
  const policy = await loadFlowAccess();
  return Response.json({ policy });
}

export async function PATCH(req: NextRequest) {
  const auth = await checkAdmin(req);
  if (!auth.ok) return new Response(auth.message, { status: auth.status });

  let body: Partial<FlowAccessPolicy> & { regenerateLink?: boolean };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return new Response('Body must be valid JSON', { status: 400 });
  }

  if (body.mode !== undefined) {
    const allowed: FlowAccessMode[] = ['public', 'anyone-with-link', 'restricted'];
    if (!allowed.includes(body.mode as FlowAccessMode)) {
      return new Response(
        `mode must be one of ${allowed.join(', ')} (got "${body.mode}")`,
        { status: 400 }
      );
    }
  }
  if (body.allowedGroups !== undefined && !Array.isArray(body.allowedGroups)) {
    return new Response('allowedGroups must be an array', { status: 400 });
  }
  if (body.allowedUsers !== undefined && !Array.isArray(body.allowedUsers)) {
    return new Response('allowedUsers must be an array', { status: 400 });
  }

  try {
    const updated = await saveFlowAccess(
      {
        mode: body.mode as FlowAccessMode | undefined,
        allowedGroups: Array.isArray(body.allowedGroups)
          ? body.allowedGroups.map((s) => String(s)).filter(Boolean)
          : undefined,
        allowedUsers: Array.isArray(body.allowedUsers)
          ? body.allowedUsers.map((s) => String(s)).filter(Boolean)
          : undefined,
        regenerateLink: body.regenerateLink === true
      },
      auth.user.oid
    );
    const auditAction = body.regenerateLink
      ? '[admin:regen-flow-link]'
      : '[admin:update-flow-access]';
    await auditLog({
      userId: auth.user.oid,
      upn: auth.user.upn,
      query: `${auditAction} mode=${updated.mode}`,
      retrievedDocIds: [],
      retrievedTitles: ['/flow'],
      responsePreview: `Admin ${auth.user.upn || auth.user.oid} ${
        body.regenerateLink ? 'regenerated /flow share link' : `set /flow access to "${updated.mode}"`
      } (groups=${updated.allowedGroups.length}, users=${updated.allowedUsers.length})`,
      groupCount: auth.groups.length,
      timestamp: new Date().toISOString()
    }).catch(() => {});
    return Response.json({ policy: updated });
  } catch (e) {
    return new Response(`Failed to save: ${(e as Error).message}`, { status: 500 });
  }
}
