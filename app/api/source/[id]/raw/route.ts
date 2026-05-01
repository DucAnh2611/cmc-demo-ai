import '@/lib/envGuard';
import { NextRequest } from 'next/server';
import { verifyAccessToken } from '@/lib/auth/verifyToken';
import { getUserGroups } from '@/lib/auth/getUserGroups';
import { buildGroupFilter, getSearchClient } from '@/lib/search/secureSearch';
import { downloadBlob, isBlobConfigured } from '@/lib/storage/blobClient';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface IndexedDoc {
  id: string;
  title: string;
  content: string;
  sourceUrl?: string;
  department?: string;
  allowedGroups?: string[];
  /** Set on uploaded chunks — when present the raw endpoint returns the
   * original binary instead of the reconstructed markdown. */
  blobName?: string;
}

/**
 * Returns the original document as a downloadable Markdown file
 * (frontmatter + body), with the same ACL filter as /api/source/[id].
 * The browser-side caller fetches with a Bearer token, then drops the
 * response into an anchor with download attribute — so the auth context
 * is preserved (no new tab + sessionStorage isolation problem).
 */
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
  if (!aclFilter) return new Response('Not authorized', { status: 403 });

  const escapedId = id.replace(/'/g, "''");
  const filter = `(id eq '${escapedId}') and (${aclFilter})`;

  const client = getSearchClient();
  const results = await client.search('*', {
    filter,
    select: ['id', 'content', 'title', 'sourceUrl', 'department', 'allowedGroups', 'blobName'],
    top: 1
  });

  for await (const item of results.results) {
    const d = item.document as IndexedDoc;

    // If this chunk came from an upload it carries a blobName — return the
    // original binary (PDF/DOCX/etc.) instead of reconstructing markdown.
    if (d.blobName && isBlobConfigured()) {
      const blob = await downloadBlob(d.blobName);
      if (blob) {
        const originalName = decodeURIComponent(blob.metadata.original_filename || d.blobName);
        return new Response(blob.buffer as BodyInit, {
          status: 200,
          headers: {
            'Content-Type': blob.contentType,
            'Content-Disposition': `attachment; filename="${originalName.replace(/"/g, '')}"`,
            'Cache-Control': 'private, no-store'
          }
        });
      }
      // Blob row exists but file missing — fall through to markdown.
    }

    // Sample / seed docs: reconstruct the original .md file (frontmatter + body).
    const frontmatterLines: string[] = ['---', `title: ${d.title}`];
    if (d.department) frontmatterLines.push(`department: ${d.department}`);
    if (d.allowedGroups?.length) {
      frontmatterLines.push('allowedGroups:');
      for (const g of d.allowedGroups) frontmatterLines.push(`  - ${g}`);
    }
    if (d.sourceUrl) frontmatterLines.push(`sourceUrl: ${d.sourceUrl}`);
    frontmatterLines.push('---', '');
    const body = `${frontmatterLines.join('\n')}\n${d.content}\n`;

    return new Response(body, {
      status: 200,
      headers: {
        'Content-Type': 'text/markdown; charset=utf-8',
        'Content-Disposition': `attachment; filename="${d.id}.md"`,
        'Cache-Control': 'private, no-store'
      }
    });
  }

  return new Response('Not found or not authorized', { status: 404 });
}
