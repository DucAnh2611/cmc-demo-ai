import '@/lib/envGuard';
import { NextRequest } from 'next/server';
import { checkAdmin } from '@/lib/admin/requireAdmin';
import { createRule, listAllRules, validateRuleDraft, type SensitivityRule } from '@/lib/security/rules';
import { auditLog } from '@/lib/audit/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const auth = await checkAdmin(req);
  if (!auth.ok) return new Response(auth.message, { status: auth.status });
  const rules = await listAllRules();
  return Response.json({ rules });
}

export async function POST(req: NextRequest) {
  const auth = await checkAdmin(req);
  if (!auth.ok) return new Response(auth.message, { status: auth.status });

  let body: Partial<SensitivityRule>;
  try {
    body = (await req.json()) as Partial<SensitivityRule>;
  } catch {
    return new Response('Body must be valid JSON', { status: 400 });
  }

  // Normalise — trim/dedupe phrase strings, default groups to empty
  // (= applies to everyone), default enabled to true.
  const cleanPhrases = Array.isArray(body.phrases)
    ? Array.from(
        new Set(
          body.phrases
            .map((p: unknown) => (typeof p === 'string' ? p.trim() : ''))
            .filter((p: string) => p.length > 0)
        )
      )
    : [];
  const draft: Omit<SensitivityRule, 'id' | 'createdAt' | 'updatedAt' | 'createdBy'> = {
    label: (body.label || '').trim(),
    phrases: cleanPhrases,
    groups: Array.isArray(body.groups) ? body.groups : [],
    enabled: body.enabled !== false
  };
  const v = validateRuleDraft(draft);
  if (!v.ok) return new Response(v.message, { status: 400 });

  try {
    const created = await createRule(draft, auth.user.oid);
    const scope =
      created.groups.length === 0 ? 'all groups' : `${created.groups.length} groups`;
    await auditLog({
      userId: auth.user.oid,
      upn: auth.user.upn,
      query: `[admin:create-rule] ${created.label}`,
      retrievedDocIds: [created.id],
      retrievedTitles: [created.label],
      responsePreview: `Admin ${auth.user.upn || auth.user.oid} created sensitivity rule "${created.label}" (phrases=${created.phrases.length}, scope=${scope})`,
      groupCount: auth.groups.length,
      timestamp: new Date().toISOString()
    }).catch(() => {});
    return Response.json({ rule: created }, { status: 201 });
  } catch (e) {
    return new Response(`Failed to create rule: ${(e as Error).message}`, { status: 500 });
  }
}
