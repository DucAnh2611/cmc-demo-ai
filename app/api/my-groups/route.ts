import '@/lib/envGuard';
import { NextRequest } from 'next/server';
import { verifyAccessToken } from '@/lib/auth/verifyToken';
import { getUserGroups } from '@/lib/auth/getUserGroups';
import { isAppAdmin } from '@/lib/admin/isAppAdmin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface GraphMemberOfResponse {
  value: Array<{
    '@odata.type': string;
    id: string;
    displayName?: string;
    description?: string;
    /** Present on group objects; missing on directory roles / app roles. */
    securityEnabled?: boolean;
    mailEnabled?: boolean;
  }>;
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

  // App admins get the FULL list of Security groups in the tenant (so
  // they can share uploads with any group, not only the ones they
  // belong to). Non-admins see only their own transitiveMemberOf — same
  // contract as before this change.
  const callerGroups = await getUserGroups(token);
  const admin = isAppAdmin(callerGroups);

  const groups: Array<{ id: string; displayName: string; memberCount?: number | null }> = [];
  // Note: Graph rejects $filter + $orderby together on /groups unless
  // BOTH `ConsistencyLevel: eventual` (already sent below) AND
  // `$count=true` are present. Without $count=true the request fails with
  // "Request_UnsupportedQuery: Sorting not supported for current query."
  //
  // We pull `securityEnabled,mailEnabled` on both paths so the non-admin
  // (transitiveMemberOf) path can apply the same Security-group filter
  // the admin path uses. Without it, transitiveMemberOf would surface
  // M365 unified groups, distribution lists, and directory roles —
  // none of which work as RAG ACL groups. The admin Groups list uses
  // the same filter, so the upload picker now matches that list 1:1.
  let next: string | undefined = admin
    ? 'https://graph.microsoft.com/v1.0/groups' +
      '?$select=id,displayName,securityEnabled,mailEnabled' +
      '&$filter=securityEnabled eq true and mailEnabled eq false' +
      '&$orderby=displayName&$count=true&$top=200'
    : 'https://graph.microsoft.com/v1.0/me/transitiveMemberOf' +
      '?$select=id,displayName,securityEnabled,mailEnabled&$top=200';

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
      // /me/transitiveMemberOf returns mixed directoryObjects (groups,
      // directory roles, app role assignments) with an @odata.type
      // discriminator. /groups returns groups directly with no
      // discriminator. Accept only group objects, then narrow further
      // to Security groups (securityEnabled=true, mailEnabled=false) —
      // the only kind that show up in transitiveMemberOf claims and
      // therefore work as RAG ACL groups.
      const t = obj['@odata.type'];
      const isGroup = !t || t === '#microsoft.graph.group';
      if (!isGroup) continue;
      if (obj.securityEnabled !== true || obj.mailEnabled !== false) continue;
      groups.push({ id: obj.id, displayName: obj.displayName || obj.id });
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
  // endpoint re-checks this server-side regardless. Admins always
  // canUpload — they bypass the uploader-group gate.
  const uploaderGroupId = (process.env.GROUP_UPLOADERS_ID || '').trim() || null;
  const adminGroupId = (process.env.GROUP_APP_ADMINS_ID || '').trim() || null;
  const canUpload = admin
    ? true
    : uploaderGroupId
    ? callerGroups.includes(uploaderGroupId)
    : true; // when no gate is set, anyone authenticated can upload

  // Surface adminGroupId so the upload picker can hide it. Permission
  // groups (uploaders + app-admins) are not content groups — sharing a
  // doc INTO them would silently broaden access to anyone who later
  // gets uploader/admin privileges. The /api/upload route re-rejects
  // both group IDs server-side; this is the matching UI affordance.
  return Response.json({ groups, canUpload, uploaderGroupId, adminGroupId, isAdmin: admin });
}
