import '@/lib/envGuard';
import { NextRequest } from 'next/server';
import { verifyAccessToken } from '@/lib/auth/verifyToken';
import { getUserGroups } from '@/lib/auth/getUserGroups';
import { buildGroupFilter, getSearchClient } from '@/lib/search/secureSearch';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface IndexedChunk {
  id: string;
  title: string;
  department?: string;
  sourceUrl?: string;
  allowedGroups?: string[];
  uploader_oid?: string;
}

interface DocSummary {
  id: string;
  title: string;
  department?: string;
  sourceUrl?: string;
  /** Identifies provenance for the UI badge:
   *   - 'self'  — uploaded by the caller
   *   - 'other' — uploaded by another user in a group I share
   *   - 'seed'  — built-in sample doc (no uploader_oid)
   * Lets the modal show "Uploaded by you" / "Uploaded" / "Seed" without
   * leaking other users' identifiers to the client. */
  provenance: 'self' | 'other' | 'seed';
  /** Group IDs the doc is shared with. The UI resolves these to display
   * names via /api/my-groups (the caller already passed ACL on these
   * chunks, so listing the IDs is not an info disclosure beyond what they
   * could enumerate by uploading themselves). */
  allowedGroups: string[];
}

/**
 * Returns every distinct document the caller is authorized to read, derived
 * from chunks in the Azure AI Search index after ACL filtering. Multiple
 * chunks from the same source file are deduplicated by title (one row per
 * doc). The chunk `id` returned is whichever was retrieved first — the UI
 * uses it to open the source modal.
 *
 * Query params:
 *   ?mine=true — additionally filter to docs uploaded by the caller. Useful
 *                because the default view is "everything I CAN read" (which
 *                includes other users' uploads to my groups), and operators
 *                often want a "just my uploads" sub-view to manage what they
 *                published. The mine filter is ANDed with the ACL filter, so
 *                this NEVER widens access — it can only narrow it.
 *
 * Same auth + ACL pattern as /api/chat and /api/source/[id]: bearer token
 * → claims-only validation → server-side group fetch → search.in filter
 * inside Azure AI Search.
 */
export async function GET(req: NextRequest) {
  const auth = req.headers.get('authorization') || '';
  const m = /^Bearer (.+)$/.exec(auth);
  if (!m) return new Response('Missing bearer token', { status: 401 });
  const token = m[1];

  let user;
  try {
    user = await verifyAccessToken(token);
  } catch (e) {
    return new Response(`Invalid token: ${(e as Error).message}`, { status: 401 });
  }

  const url = new URL(req.url);
  const mineOnly = url.searchParams.get('mine') === 'true';

  const groups = await getUserGroups(token);
  const aclFilter = buildGroupFilter(groups);
  if (!aclFilter) {
    // No groups → nothing visible. Return empty list rather than 403 so the
    // UI can show a friendly "you don't have access to any documents" state.
    return Response.json({ docs: [], groupCount: 0 });
  }

  // The mine filter is ANDed with the ACL filter — uploader_oid alone is NOT
  // a permission grant. A user must still be in one of the doc's allowedGroups
  // to see it. This protects the case where a former group member uploaded a
  // doc, was removed from the group, but their oid is still on the chunk.
  const filter = mineOnly
    ? `(${aclFilter}) and uploader_oid eq '${user.oid.replace(/'/g, "''")}'`
    : aclFilter;

  const client = getSearchClient();
  const results = await client.search('*', {
    filter,
    select: ['id', 'title', 'department', 'sourceUrl', 'allowedGroups', 'uploader_oid'],
    top: 1000
  });

  // Dedupe by title — multiple chunks of the same .md file share a title.
  // Keep the first chunk's id as a clickable handle; the source modal can
  // resolve and display its content.
  const byTitle = new Map<string, DocSummary>();
  for await (const item of results.results) {
    const d = item.document as IndexedChunk;
    if (!byTitle.has(d.title)) {
      let provenance: DocSummary['provenance'];
      if (!d.uploader_oid) provenance = 'seed';
      else if (d.uploader_oid === user.oid) provenance = 'self';
      else provenance = 'other';

      byTitle.set(d.title, {
        id: d.id,
        title: d.title,
        department: d.department,
        sourceUrl: d.sourceUrl,
        provenance,
        allowedGroups: d.allowedGroups || []
      });
    }
  }

  const docs = Array.from(byTitle.values()).sort((a, b) => {
    const deptCmp = (a.department || '').localeCompare(b.department || '');
    if (deptCmp !== 0) return deptCmp;
    return a.title.localeCompare(b.title);
  });

  return Response.json({ docs, groupCount: groups.length });
}
