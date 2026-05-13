import '@/lib/envGuard';
import { NextRequest } from 'next/server';
import { checkAdmin } from '@/lib/admin/requireAdmin';
import { getRule, updateRule, deleteRule, type SensitivityRule } from '@/lib/security/rules';
import { auditLog } from '@/lib/audit/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await checkAdmin(req);
  if (!auth.ok) return new Response(auth.message, { status: auth.status });
  const rule = await getRule(params.id);
  if (!rule) return new Response('Rule not found', { status: 404 });
  return Response.json({ rule });
}

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await checkAdmin(req);
  if (!auth.ok) return new Response(auth.message, { status: auth.status });

  let body: Partial<SensitivityRule>;
  try {
    body = (await req.json()) as Partial<SensitivityRule>;
  } catch {
    return new Response('Body must be valid JSON', { status: 400 });
  }

  const patch: Partial<SensitivityRule> = {};
  if (body.label !== undefined) patch.label = String(body.label).trim();
  if (body.phrases !== undefined) {
    patch.phrases = Array.isArray(body.phrases)
      ? Array.from(
          new Set(
            body.phrases
              .map((p: unknown) => (typeof p === 'string' ? p.trim() : ''))
              .filter((p: string) => p.length > 0)
          )
        )
      : [];
  }
  if (body.groups !== undefined) {
    patch.groups = Array.isArray(body.groups) ? body.groups : [];
  }
  if (body.enabled !== undefined) patch.enabled = !!body.enabled;
  if (Object.keys(patch).length === 0) {
    return new Response('No updatable fields in body', { status: 400 });
  }

  try {
    const updated = await updateRule(params.id, patch);
    await auditLog({
      userId: auth.user.oid,
      upn: auth.user.upn,
      query: `[admin:update-rule] ${updated.label}`,
      retrievedDocIds: [updated.id],
      retrievedTitles: [updated.label],
      responsePreview: `Admin ${auth.user.upn || auth.user.oid} updated rule "${updated.label}"; fields=${Object.keys(patch).join(',')}`,
      groupCount: auth.groups.length,
      timestamp: new Date().toISOString()
    }).catch(() => {});
    return Response.json({ rule: updated });
  } catch (e) {
    const msg = (e as Error).message;
    if (/not found/i.test(msg)) return new Response(msg, { status: 404 });
    return new Response(`Failed to update rule: ${msg}`, { status: 400 });
  }
}

export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await checkAdmin(req);
  if (!auth.ok) return new Response(auth.message, { status: auth.status });

  const existing = await getRule(params.id);
  if (!existing) return new Response('Rule not found', { status: 404 });

  try {
    await deleteRule(params.id);
    await auditLog({
      userId: auth.user.oid,
      upn: auth.user.upn,
      query: `[admin:delete-rule] ${existing.label}`,
      retrievedDocIds: [existing.id],
      retrievedTitles: [existing.label],
      responsePreview: `Admin ${auth.user.upn || auth.user.oid} deleted rule "${existing.label}" (phrases: ${existing.phrases.slice(0, 5).join(', ')}${existing.phrases.length > 5 ? '…' : ''})`,
      groupCount: auth.groups.length,
      timestamp: new Date().toISOString()
    }).catch(() => {});
    return new Response(null, { status: 204 });
  } catch (e) {
    return new Response(`Failed to delete rule: ${(e as Error).message}`, { status: 500 });
  }
}
