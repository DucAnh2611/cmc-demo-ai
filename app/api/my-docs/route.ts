import '@/lib/envGuard';
import { NextRequest } from 'next/server';
import { verifyAccessToken } from '@/lib/auth/verifyToken';
import { getUserGroups } from '@/lib/auth/getUserGroups';
import { buildGroupFilter, getSearchClient } from '@/lib/search/secureSearch';
import { deleteBlob } from '@/lib/storage/blobClient';
import { auditLog } from '@/lib/audit/logger';
import { isAppAdmin } from '@/lib/admin/isAppAdmin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface IndexedChunk {
  id: string;
  title: string;
  department?: string;
  sourceUrl?: string;
  allowedGroups?: string[];
  uploader_oid?: string;
  /** Set on uploaded chunks; absent on seed docs. The blob path's
   *  extension is the most reliable format indicator we have. */
  blobName?: string;
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
  /** True when the caller is allowed to DELETE this doc — drives the UI
   *  affordance. Mirrors the server-side rule in the DELETE handler:
   *    - false for seed docs (no uploader_oid; cannot be deleted via API)
   *    - true if caller uploaded it (uploader_oid matches)
   *    - true if caller is a member of GROUP_UPLOADERS_ID (department admin) */
  canDelete: boolean;
  /** Uppercase format token (e.g. 'PDF', 'DOCX', 'MD') derived from the
   *  blob path's extension. 'MD' for seed docs (they're all Markdown).
   *  Drives the small format pill in MyDocsModal so users can tell at a
   *  glance which doc came in as which file type. */
  format: string;
  /** Original filename as the user uploaded it, when known. Empty for
   *  seed docs (their "filename" is just the chunk id). Used in the
   *  source modal so the user sees the exact name they uploaded. */
  originalFilename: string;
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
  const admin = isAppAdmin(groups);
  const aclFilter = buildGroupFilter(groups);
  if (!admin && !aclFilter) {
    // Non-admin with no groups → nothing visible. Return empty list rather
    // than 403 so the UI can show a friendly "you don't have access to any
    // documents" state. Admins skip this entirely — they see every doc.
    return Response.json({ docs: [], groupCount: 0 });
  }

  // "Department admin" / uploader-group membership — already lets the
  // caller delete ANY uploaded doc (not just their own). App admins are
  // a tenant-wide superset of this.
  const uploadersGroupId = (process.env.GROUP_UPLOADERS_ID || '').trim();
  const isUploadAdmin = (!!uploadersGroupId && groups.includes(uploadersGroupId)) || admin;

  // Filter logic:
  //   admin + mine=false  → no filter at all (sees every doc)
  //   admin + mine=true   → uploader_oid filter only (their own uploads)
  //   user + mine=false   → ACL filter only
  //   user + mine=true    → ACL filter AND uploader_oid filter
  let filter: string | undefined;
  if (mineOnly) {
    const mineExpr = `uploader_oid eq '${user.oid.replace(/'/g, "''")}'`;
    filter = admin ? mineExpr : `(${aclFilter}) and ${mineExpr}`;
  } else {
    filter = admin ? undefined : (aclFilter as string);
  }

  const client = getSearchClient();
  const results = await client.search('*', {
    ...(filter ? { filter } : {}),
    select: ['id', 'title', 'department', 'sourceUrl', 'allowedGroups', 'uploader_oid', 'blobName'],
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

      // canDelete mirrors the DELETE handler's authorisation:
      //   seed docs        → never deletable via this API
      //   user's own       → always deletable
      //   other user's     → deletable when caller is in uploaders group
      const canDelete =
        provenance === 'self' || (provenance === 'other' && isUploadAdmin);

      // Derive original filename + format from blobName. Upload route
      // writes blobName as `docs/<dept>/<8-hex>-<sanitised-original-name>`
      // — strip the docs/dept/<id>- prefix to recover the user's name.
      // Seed docs have no blobName; they're always Markdown by convention.
      let originalFilename = '';
      let format = 'MD';
      if (d.blobName) {
        const base = d.blobName.replace(/^.*\//, '');
        originalFilename = base.replace(/^[a-f0-9]{8}-/, '');
        const extMatch = /\.([a-zA-Z0-9]+)$/.exec(originalFilename || base);
        format = extMatch ? extMatch[1].toUpperCase() : 'FILE';
      }

      byTitle.set(d.title, {
        id: d.id,
        title: d.title,
        department: d.department,
        sourceUrl: d.sourceUrl,
        provenance,
        allowedGroups: d.allowedGroups || [],
        canDelete,
        format,
        originalFilename
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

/**
 * Delete a user-uploaded document and all its chunks. Used by the
 * MyDocsModal trash button. Authorised when the caller is the original
 * uploader OR a member of GROUP_UPLOADERS_ID (department admin).
 *
 * Query params:
 *   ?id=<chunkId>   one of the doc's chunk ids (the GET response gives
 *                   the first chunk's id as the click handle, so the UI
 *                   passes the same value here).
 *
 * Response codes:
 *   200 — deleted (returns counts of chunks + blob)
 *   400 — missing/invalid `id`
 *   401 — bad bearer token
 *   403 — chunk is a seed doc OR caller has neither ownership nor
 *         uploader-group membership
 *   404 — no chunk matches that id (already deleted, or wrong id)
 *
 * Audit: writes a 'rag_query'-shaped audit event with query
 * "[delete] <title>" so deletions are traceable in the same KQL view.
 */
export async function DELETE(req: NextRequest) {
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
  const id = (url.searchParams.get('id') || '').trim();
  if (!id) return new Response('Missing required query param: id', { status: 400 });

  const groups = await getUserGroups(token);
  const uploadersGroupId = (process.env.GROUP_UPLOADERS_ID || '').trim();
  // App admins are a tenant-wide superset of department uploaders —
  // they can delete any uploaded doc regardless of which group it was
  // shared with.
  const isUploadAdmin =
    (!!uploadersGroupId && groups.includes(uploadersGroupId)) || isAppAdmin(groups);

  const client = getSearchClient();

  // Step 1: look up the target chunk by id. The lookup is intentionally
  // NOT ACL-filtered — authorisation is decided below from the chunk's
  // uploader_oid + allowedGroups. The ACL filter would already block
  // delete attempts on docs the caller can't even read, but we want a
  // 403 (clear "not allowed") rather than a 404 (looks like a typo)
  // when the user knows the doc exists but doesn't own it.
  let target: IndexedChunk | null = null;
  try {
    const lookup = await client.search('*', {
      filter: `id eq '${id.replace(/'/g, "''")}'`,
      select: ['id', 'title', 'allowedGroups', 'uploader_oid'],
      top: 1
    });
    for await (const item of lookup.results) {
      target = item.document as IndexedChunk;
      break;
    }
  } catch (e) {
    return new Response(`Search lookup failed: ${(e as Error).message}`, { status: 500 });
  }
  if (!target) return new Response(`No chunk with id ${id}`, { status: 404 });

  // Step 2: authorise. Seed docs (no uploader_oid) are read-only via this
  // API. Non-uploader users must be in the uploaders group.
  if (!target.uploader_oid) {
    return new Response('Cannot delete a seed doc via this API', { status: 403 });
  }
  const isOwner = target.uploader_oid === user.oid;
  if (!isOwner && !isUploadAdmin) {
    return new Response(
      'Not allowed to delete this doc — only the uploader or a member of the uploaders group can delete.',
      { status: 403 }
    );
  }

  // Step 3: find every sibling chunk for this same source doc. They all
  // share `uploader_oid` + the same blobName. We use the chunk-id
  // pattern `upload-<docId>-<i>` as a fast prefix filter, plus blobName
  // when present.
  //
  // The chunk id format is fixed by the upload route (see /api/upload):
  // `upload-<32-hex-uuid>-<chunk-index>`. Strip the `-<i>` suffix to get
  // the doc-wide prefix, then list every chunk that starts with it.
  const docPrefixMatch = /^(upload-[a-f0-9]{32})-\d+$/.exec(target.id);
  const siblingIds: string[] = [];
  let blobName: string | null = null;
  let title = target.title;

  if (docPrefixMatch) {
    const docPrefix = docPrefixMatch[1];
    try {
      // Pull every chunk that belongs to this same upload. We can't use
      // startswith() / search.ismatch() — the former isn't supported in
      // Azure AI Search's OData dialect at all, the latter requires a
      // SEARCHABLE field and our `id` is only filterable+key.
      //
      // Trick: a range comparison on the filterable `id` simulates a
      // prefix match. Chunk ids look like `upload-<32-hex>-<i>` where
      // `<i>` is always a digit run (0-9). In ASCII `:` (0x3a) is
      // immediately after `9` (0x39), so any chunk id starting with
      // `<docPrefix>-` is captured by `id ge '<docPrefix>-' and id lt
      // '<docPrefix>-:'`. Works for single-digit AND multi-digit chunk
      // suffixes (lex compare on `99` vs `:` still puts `99` lower).
      // Top: 500 covers a single 10 MB doc's ~250 chunks comfortably.
      const idLow = `${docPrefix}-`;
      const idHigh = `${docPrefix}-:`;
      const siblings = await client.search('*', {
        filter: `id ge '${idLow}' and id lt '${idHigh}'`,
        select: ['id', 'blobName', 'title'],
        top: 500
      });
      for await (const item of siblings.results) {
        const d = item.document as IndexedChunk & { blobName?: string };
        siblingIds.push(d.id);
        if (!blobName && d.blobName) blobName = d.blobName;
        if (d.title) title = d.title;
      }
    } catch (e) {
      return new Response(`Sibling lookup failed: ${(e as Error).message}`, { status: 500 });
    }
  } else {
    // Fallback: id doesn't match the upload pattern (shouldn't happen,
    // but defensively delete just the one chunk we found).
    siblingIds.push(target.id);
  }

  // Step 4: batch-delete chunks from Search.
  let chunksDeleted = 0;
  try {
    // The SDK's deleteDocuments takes objects with the key field (id).
    // Batch in chunks of 50 to mirror the upload-side pattern.
    const BATCH = 50;
    for (let i = 0; i < siblingIds.length; i += BATCH) {
      const slice = siblingIds.slice(i, i + BATCH).map((cid) => ({ id: cid }));
      // SDK type narrows to indexed shape; deleteDocuments accepts the
      // key-only form.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await client.deleteDocuments(slice as any);
      chunksDeleted += slice.length;
    }
  } catch (e) {
    return new Response(`Search delete failed: ${(e as Error).message}`, { status: 500 });
  }

  // Step 5: best-effort blob delete. Failure here is logged but doesn't
  // fail the API call — chunks-gone is what matters for retrieval. The
  // blob becomes orphan and can be cleaned up manually later.
  let blobDeleted = false;
  if (blobName) {
    try {
      await deleteBlob(blobName);
      blobDeleted = true;
    } catch (e) {
      console.warn('[my-docs] blob delete failed (chunks already gone)', {
        blobName,
        error: (e as Error).message
      });
    }
  }

  // Step 6: audit. Same shape as chat audit so the KQL view picks it up.
  await auditLog({
    userId: user.oid,
    upn: user.upn,
    query: `[delete] ${title}`,
    retrievedDocIds: siblingIds,
    retrievedTitles: [title],
    responsePreview: `Deleted ${chunksDeleted} chunk(s)${blobDeleted ? ', blob removed' : blobName ? ', blob delete FAILED' : ''}; deleter=${user.upn || user.oid}; admin=${isUploadAdmin && !isOwner}`,
    groupCount: groups.length,
    timestamp: new Date().toISOString()
  }).catch(() => {});

  return Response.json({
    ok: true,
    title,
    chunksDeleted,
    blobName,
    blobDeleted,
    deletedAs: isOwner ? 'owner' : 'uploads-admin'
  });
}
