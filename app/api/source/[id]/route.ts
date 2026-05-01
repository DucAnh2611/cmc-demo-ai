import '@/lib/envGuard';
import { NextRequest } from 'next/server';
import { verifyAccessToken } from '@/lib/auth/verifyToken';
import { getUserGroups } from '@/lib/auth/getUserGroups';
import { buildGroupFilter, getSearchClient } from '@/lib/search/secureSearch';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface IndexedDoc {
  id: string;
  title: string;
  content: string;
  sourceUrl?: string;
  department?: string;
  allowedGroups?: string[];
}

export async function GET(req: NextRequest, ctx: { params: { id: string } }) {
  const auth = req.headers.get('authorization') || '';
  const m = /^Bearer (.+)$/.exec(auth);
  if (!m) return new Response('Missing bearer token', { status: 401 });
  const token = m[1];

  try {
    await verifyAccessToken(token);
  } catch (e) {
    return new Response(`Invalid token: ${(e as Error).message}`, { status: 401 });
  }

  const id = ctx.params.id;
  if (!id || !/^[\w-]+$/.test(id)) {
    return new Response('Invalid id', { status: 400 });
  }

  const groups = await getUserGroups(token);
  const aclFilter = buildGroupFilter(groups);
  if (!aclFilter) {
    return new Response('Not authorized', { status: 403 });
  }

  // Combine doc-id filter with the ACL filter so an unauthorized user can't
  // peek at a doc just by guessing its id.
  const escapedId = id.replace(/'/g, "''");
  const filter = `(id eq '${escapedId}') and (${aclFilter})`;

  const client = getSearchClient();
  const results = await client.search('*', {
    filter,
    select: ['id', 'content', 'title', 'sourceUrl', 'department'],
    top: 1
  });

  for await (const item of results.results) {
    const d = item.document as IndexedDoc;
    return Response.json({
      id: d.id,
      title: d.title,
      department: d.department,
      sourceUrl: d.sourceUrl,
      content: d.content
    });
  }

  // Either the id doesn't exist, or it exists but the user's groups don't
  // intersect its allowedGroups. Same response either way — don't reveal
  // whether the doc exists.
  return new Response('Not found or not authorized', { status: 404 });
}
