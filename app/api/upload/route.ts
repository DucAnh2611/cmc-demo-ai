import '@/lib/envGuard';
import { NextRequest } from 'next/server';
import { randomUUID } from 'node:crypto';
import { verifyAccessToken } from '@/lib/auth/verifyToken';
import { getUserGroups } from '@/lib/auth/getUserGroups';
import { embedBatch } from '@/lib/search/embedder';
import { getSearchClient } from '@/lib/search/secureSearch';
import { chunkText } from '@/lib/utils/chunker';
import { isBlobConfigured, uploadBlob } from '@/lib/storage/blobClient';
import {
  ALLOWED_EXTENSIONS,
  extract,
  isSupported,
  normaliseContentType
} from '@/lib/extractors';
import { auditLog } from '@/lib/audit/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_FILES = 5;
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB

interface UploadResult {
  filename: string;
  ok: boolean;
  error?: string;
  doc?: {
    /** First chunk id — used by the UI to open the source modal. */
    id: string;
    title: string;
    chunks: number;
    blobName: string;
  };
}

function extOf(filename: string): string {
  const m = /\.([^.]+)$/.exec(filename);
  return m ? `.${m[1].toLowerCase()}` : '';
}

/** Strip directory components and replace anything outside `[a-zA-Z0-9._-]`
 *  with a dash, so the original filename is safe to use inside a Blob path
 *  while still being recognisable to the user when they look at the
 *  container in the portal. Capped at 80 chars. */
function sanitizeFilename(name: string): string {
  return name
    .replace(/^.*[\\/]/, '') // drop anything before the last slash
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

export async function POST(req: NextRequest) {
  if (!isBlobConfigured()) {
    return new Response(
      'Blob storage is not configured. Set AZURE_STORAGE_CONNECTION_STRING in .env.local.',
      { status: 503 }
    );
  }

  // ---------- Auth ----------
  const auth = req.headers.get('authorization') || '';
  const bearer = /^Bearer (.+)$/.exec(auth);
  if (!bearer) return new Response('Missing bearer token', { status: 401 });
  const token = bearer[1];

  let user;
  try {
    user = await verifyAccessToken(token);
  } catch (e) {
    return new Response(`Invalid token: ${(e as Error).message}`, { status: 401 });
  }

  // ---------- Parse multipart body ----------
  let formData: FormData;
  try {
    formData = await req.formData();
  } catch {
    return new Response('Body must be multipart/form-data', { status: 400 });
  }

  // ---------- Validate ACL: uploader can only share with groups they belong to ----------
  const requestedGroups = formData
    .getAll('allowedGroups')
    .map((v) => String(v).trim())
    .filter(Boolean);
  if (requestedGroups.length === 0) {
    return new Response('Pick at least one group to share the document with.', { status: 400 });
  }

  const userGroups = await getUserGroups(token);
  const userGroupSet = new Set(userGroups);

  // Optional gate: only members of GROUP_UPLOADERS_ID can use this endpoint.
  // When the env var is set, non-members get a clean 403 even if they would
  // otherwise be allowed to share with their groups.
  const uploaderGroupId = (process.env.GROUP_UPLOADERS_ID || '').trim();
  if (uploaderGroupId && !userGroupSet.has(uploaderGroupId)) {
    return new Response(
      'Upload permission denied. Your account is not a member of the uploaders group.',
      { status: 403 }
    );
  }

  const unauthorisedGroups = requestedGroups.filter((g) => !userGroupSet.has(g));
  if (unauthorisedGroups.length > 0) {
    return new Response(
      `You can only share documents with groups you belong to. Unauthorized: ${unauthorisedGroups.join(', ')}`,
      { status: 403 }
    );
  }
  // Don't allow sharing INTO the uploaders group — it's a permission group,
  // not a content group. Otherwise an uploader could publish docs that any
  // future uploader could see.
  if (uploaderGroupId && requestedGroups.includes(uploaderGroupId)) {
    return new Response(
      `Cannot share with the uploaders group itself — pick content groups (HR / Finance / Public / etc.) instead.`,
      { status: 400 }
    );
  }

  // ---------- Validate file count + size + type ----------
  const files = formData.getAll('files').filter((v): v is File => v instanceof File);
  if (files.length === 0) {
    return new Response('No files uploaded (use form field name "files").', { status: 400 });
  }
  if (files.length > MAX_FILES) {
    return new Response(`Too many files: ${files.length}. Max ${MAX_FILES} per upload.`, { status: 400 });
  }

  // Derive `department` from the most-specific picked group so uploads
  // land alongside seed docs in the same dept bucket (e.g. an upload
  // shared with HR + Public groups gets department=hr; Public-only gets
  // department=public). Falls back to 'uploads' if no env mapping matches.
  const HR_ID = (process.env.GROUP_HR_ID || '').trim();
  const FIN_ID = (process.env.GROUP_FINANCE_ID || '').trim();
  const PUB_ID = (process.env.GROUP_PUBLIC_ID || '').trim();
  let department = 'uploads';
  if (HR_ID && requestedGroups.includes(HR_ID)) department = 'hr';
  else if (FIN_ID && requestedGroups.includes(FIN_ID)) department = 'finance';
  else if (PUB_ID && requestedGroups.includes(PUB_ID)) department = 'public';

  const results: UploadResult[] = [];
  const indexBatch: Record<string, unknown>[] = [];

  for (const file of files) {
    if (file.size > MAX_FILE_SIZE) {
      results.push({
        filename: file.name,
        ok: false,
        error: `File too large (${file.size} bytes; max ${MAX_FILE_SIZE} = 10 MB).`
      });
      continue;
    }

    const ct = normaliseContentType(file.name, file.type);
    if (!isSupported(ct)) {
      results.push({
        filename: file.name,
        ok: false,
        error: `Unsupported type "${ct}". Allowed: ${ALLOWED_EXTENSIONS.join(', ')}`
      });
      continue;
    }

    try {
      const buffer = Buffer.from(await file.arrayBuffer());
      const extracted = await extract(buffer, file.name, ct);
      if (!extracted.text || extracted.text.trim().length < 10) {
        results.push({
          filename: file.name,
          ok: false,
          error: 'Extracted text is empty or too short. Is the file readable / not image-only?'
        });
        continue;
      }

      const docId = randomUUID().replace(/-/g, '');
      // Path: docs/<dept>/<short-id>-<safe-original-name>. Mirrors the
      // seed docs layout (docs/hr/compensation-policy.md) so the portal
      // shows seeds and uploads side-by-side under the same dept folder.
      const safeName = sanitizeFilename(file.name);
      const blobName = safeName
        ? `docs/${department}/${docId.slice(0, 8)}-${safeName}`
        : `docs/${department}/${docId}${extOf(file.name) || '.bin'}`;

      // Chunk + embed
      const chunks = chunkText(extracted.text, 500, 50);
      const vectors = await embedBatch(chunks);

      // Store the original blob with rich metadata so we can render
      // attribution and re-validate ACL out-of-band if needed.
      await uploadBlob({
        blobName,
        buffer,
        contentType: ct,
        metadata: {
          uploader_oid: user.oid,
          allowed_groups: requestedGroups.join(','),
          original_filename: encodeURIComponent(file.name),
          title: encodeURIComponent(extracted.title.slice(0, 256)),
          department: encodeURIComponent(department)
        }
      });

      // Push chunk docs into the batch — the same shape the indexer uses.
      // allowedUsers always includes the uploader so they retain access
      // even if they later leave one of the chosen groups.
      chunks.forEach((c, i) => {
        indexBatch.push({
          id: `upload-${docId}-${i}`,
          content: c,
          contentVector: vectors[i],
          title: extracted.title,
          allowedGroups: requestedGroups,
          allowedUsers: [user.oid],
          department,
          uploader_oid: user.oid,
          blobName
        });
      });

      results.push({
        filename: file.name,
        ok: true,
        doc: {
          id: `upload-${docId}-0`,
          title: extracted.title,
          chunks: chunks.length,
          blobName
        }
      });
    } catch (e) {
      results.push({ filename: file.name, ok: false, error: (e as Error).message });
    }
  }

  // ---------- Push chunks to Azure AI Search in batches of 50 ----------
  if (indexBatch.length > 0) {
    const client = getSearchClient();
    const BATCH = 50;
    for (let i = 0; i < indexBatch.length; i += BATCH) {
      // SDK type narrows to the indexed type; the runtime accepts plain objects.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const slice = indexBatch.slice(i, i + BATCH) as any;
      try {
        await client.uploadDocuments(slice);
      } catch (e) {
        // If indexing fails after blob is written, surface a partial-failure
        // error. Operator can re-run /api/upload — same blobName is idempotent
        // (Azure Blob upserts) and uploadDocuments upserts by id too.
        return new Response(
          `Some files were indexed; this batch failed: ${(e as Error).message}`,
          { status: 500 }
        );
      }
    }
  }

  // ---------- Audit ----------
  const ok = results.filter((r) => r.ok);
  const failed = results.filter((r) => !r.ok);
  await auditLog({
    userId: user.oid,
    upn: user.upn,
    query: `[upload] ${results.length} file(s)`,
    retrievedDocIds: ok.map((r) => r.doc!.id),
    retrievedTitles: ok.map((r) => r.doc!.title),
    responsePreview: `Upload by ${user.upn || user.oid}: ${ok.length} ok, ${failed.length} failed; groups=${requestedGroups.join(',')}`,
    groupCount: userGroups.length,
    timestamp: new Date().toISOString()
  }).catch(() => {});

  return Response.json({ results });
}
