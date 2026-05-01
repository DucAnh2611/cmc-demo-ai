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
}

interface DocSummary {
  id: string;
  title: string;
  department?: string;
  sourceUrl?: string;
}

/**
 * Returns every distinct document the caller is authorized to read, derived
 * from chunks in the Azure AI Search index after ACL filtering. Multiple
 * chunks from the same source file are deduplicated by title (one row per
 * doc). The chunk `id` returned is whichever was retrieved first — the UI
 * uses it to open the source modal.
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

  try {
    await verifyAccessToken(token);
  } catch (e) {
    return new Response(`Invalid token: ${(e as Error).message}`, { status: 401 });
  }

  const groups = await getUserGroups(token);
  const aclFilter = buildGroupFilter(groups);
  if (!aclFilter) {
    // No groups → nothing visible. Return empty list rather than 403 so the
    // UI can show a friendly "you don't have access to any documents" state.
    return Response.json({ docs: [], groupCount: 0 });
  }

  const client = getSearchClient();
  const results = await client.search('*', {
    filter: aclFilter,
    select: ['id', 'title', 'department', 'sourceUrl', 'allowedGroups'],
    top: 1000
  });

  // Dedupe by title — multiple chunks of the same .md file share a title.
  // Keep the first chunk's id as a clickable handle; the source modal can
  // resolve and display its content.
  const byTitle = new Map<string, DocSummary>();
  for await (const item of results.results) {
    const d = item.document as IndexedChunk;
    if (!byTitle.has(d.title)) {
      byTitle.set(d.title, {
        id: d.id,
        title: d.title,
        department: d.department,
        sourceUrl: d.sourceUrl
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
