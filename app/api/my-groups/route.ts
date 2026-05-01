import '@/lib/envGuard';
import { NextRequest } from 'next/server';
import { verifyAccessToken } from '@/lib/auth/verifyToken';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface GraphMemberOfResponse {
  value: Array<{ '@odata.type': string; id: string; displayName?: string }>;
  '@odata.nextLink'?: string;
}

/**
 * Returns the caller's Entra security groups with display names. Used by the
 * upload modal so the user can pick which group(s) to share their upload
 * with — only the ones they belong to are surfaced. The upload endpoint
 * re-validates server-side, so this is purely a UX convenience.
 *
 * Query params:
 *   ?withMemberCount=true — enrich each group with `memberCount` (live from
 *     Graph). Used by the upload confirmation step so the user sees, e.g.,
 *     "HR (12 members)" before publishing. Each enrichment is one Graph
 *     round-trip per group; failures (insufficient permission, etc.) yield
 *     `memberCount: null` for that group rather than failing the whole
 *     request.
 */
export async function GET(req: NextRequest) {
  const auth = req.headers.get('authorization') || '';
  const m = /^Bearer (.+)$/.exec(auth);
  if (!m) return new Response('Missing bearer token', { status: 401 });
  const token = m[1];

  try {
    await verifyAccessToken(token);
  } catch (e) {
    return new Response(`Invalid token: ${(e as Error).message}`, { status: 401 });
  }

  const url = new URL(req.url);
  const withMemberCount = url.searchParams.get('withMemberCount') === 'true';

  const groups: Array<{ id: string; displayName: string; memberCount?: number | null }> = [];
  let next: string | undefined =
    'https://graph.microsoft.com/v1.0/me/transitiveMemberOf?$select=id,displayName&$top=200';

  while (next) {
    const res = await fetch(next, {
      headers: {
        Authorization: `Bearer ${token}`,
        ConsistencyLevel: 'eventual'
      }
    });
    if (!res.ok) {
      return new Response(`Graph error ${res.status}: ${(await res.text()).slice(0, 300)}`, { status: 502 });
    }
    const data = (await res.json()) as GraphMemberOfResponse;
    for (const obj of data.value) {
      if (obj['@odata.type'] === '#microsoft.graph.group') {
        groups.push({ id: obj.id, displayName: obj.displayName || obj.id });
      }
    }
    next = data['@odata.nextLink'];
  }

  groups.sort((a, b) => a.displayName.localeCompare(b.displayName));

  // Member-count enrichment. Done in parallel — at most a few groups per
  // user. /members/$count requires `ConsistencyLevel: eventual`. If the
  // call fails (e.g. our scope GroupMember.Read.All doesn't grant $count
  // in some tenant configs), we set `memberCount: null` for that group;
  // the UI degrades to "members" without a number.
  if (withMemberCount && groups.length > 0) {
    await Promise.all(
      groups.map(async (g) => {
        try {
          const r = await fetch(
            `https://graph.microsoft.com/v1.0/groups/${g.id}/members/$count`,
            {
              headers: {
                Authorization: `Bearer ${token}`,
                ConsistencyLevel: 'eventual'
              }
            }
          );
          if (!r.ok) {
            g.memberCount = null;
            return;
          }
          const txt = (await r.text()).trim();
          const n = Number(txt);
          g.memberCount = Number.isFinite(n) ? n : null;
        } catch {
          g.memberCount = null;
        }
      })
    );
  }

  // Surface upload permission so the UI can hide the form (or show a "no
  // permission" message) before the user fills it in. The /api/upload
  // endpoint re-checks this server-side regardless.
  const uploaderGroupId = (process.env.GROUP_UPLOADERS_ID || '').trim() || null;
  const canUpload = uploaderGroupId
    ? groups.some((g) => g.id === uploaderGroupId)
    : true; // when no gate is set, anyone authenticated can upload

  return Response.json({ groups, canUpload, uploaderGroupId });
}
