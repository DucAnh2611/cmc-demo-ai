import '@/lib/envGuard';
import { NextRequest } from 'next/server';
import { randomUUID } from 'node:crypto';
import { verifyAccessToken } from '@/lib/auth/verifyToken';
import { getUserGroups } from '@/lib/auth/getUserGroups';
import { embedBatch } from '@/lib/search/embedder';
import { getSearchClient } from '@/lib/search/secureSearch';
import { breakLongTokens, chunkText } from '@/lib/utils/chunker';
import { isBlobConfigured, uploadBlob } from '@/lib/storage/blobClient';
import {
  ALLOWED_EXTENSIONS,
  extract,
  isSupported,
  normaliseContentType
} from '@/lib/extractors';
import { auditLog } from '@/lib/audit/logger';
import { isAppAdmin } from '@/lib/admin/isAppAdmin';

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

  // App admins are a tenant-wide superset — they bypass the uploader-
  // group gate and the per-target-group membership check (so they can
  // publish to any content group). Other safety rules (no sharing into
  // the uploaders/admins group itself, file size/type/count) still
  // apply to admins.
  const admin = isAppAdmin(userGroups);

  // Optional gate: only members of GROUP_UPLOADERS_ID can use this endpoint.
  // When the env var is set, non-members get a clean 403 even if they would
  // otherwise be allowed to share with their groups. Admins skip this gate.
  const uploaderGroupId = (process.env.GROUP_UPLOADERS_ID || '').trim();
  if (!admin && uploaderGroupId && !userGroupSet.has(uploaderGroupId)) {
    return new Response(
      'Upload permission denied. Your account is not a member of the uploaders group.',
      { status: 403 }
    );
  }

  // Non-admin users can only share with groups they themselves belong to.
  // Admin path skips this check.
  if (!admin) {
    const unauthorisedGroups = requestedGroups.filter((g) => !userGroupSet.has(g));
    if (unauthorisedGroups.length > 0) {
      return new Response(
        `You can only share documents with groups you belong to. Unauthorized: ${unauthorisedGroups.join(', ')}`,
        { status: 403 }
      );
    }
  }
  // Don't allow sharing INTO permission groups (uploaders / app-admins) —
  // those are permission groups, not content groups. Otherwise any
  // future uploader / admin would inherit access to docs published this
  // way. Applies to admins too.
  const adminGroupId = (process.env.GROUP_APP_ADMINS_ID || '').trim();
  if (uploaderGroupId && requestedGroups.includes(uploaderGroupId)) {
    return new Response(
      `Cannot share with the uploaders group itself — pick content groups (HR / Finance / Public / etc.) instead.`,
      { status: 400 }
    );
  }
  if (adminGroupId && requestedGroups.includes(adminGroupId)) {
    return new Response(
      `Cannot share with the app-admins group itself — pick content groups instead.`,
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

  console.log('[upload] batch start', {
    fileCount: files.length,
    requestedGroups,
    department,
    uploaderOid: user.oid,
    uploaderUpn: user.upn
  });

  for (const file of files) {
    // STEP 1: file received — log everything the browser told us. Useful
    // when a PDF refuses to upload — often the browser sent
    // application/octet-stream and our normaliser had to fall back to
    // extension matching.
    const ct = normaliseContentType(file.name, file.type);
    console.log('[upload] file received', {
      filename: file.name,
      sizeBytes: file.size,
      browserMime: file.type || '(empty)',
      normalisedMime: ct,
      ext: extOf(file.name)
    });

    if (file.size > MAX_FILE_SIZE) {
      console.warn('[upload] REJECT — too large', {
        filename: file.name,
        sizeBytes: file.size,
        max: MAX_FILE_SIZE
      });
      results.push({
        filename: file.name,
        ok: false,
        error: `File too large (${file.size} bytes; max ${MAX_FILE_SIZE} = 10 MB).`
      });
      continue;
    }

    if (!isSupported(ct)) {
      console.warn('[upload] REJECT — unsupported MIME', {
        filename: file.name,
        normalisedMime: ct,
        allowed: ALLOWED_EXTENSIONS
      });
      results.push({
        filename: file.name,
        ok: false,
        error: `Unsupported type "${ct}". Allowed: ${ALLOWED_EXTENSIONS.join(', ')}`
      });
      continue;
    }

    try {
      // STEP 2: read file buffer.
      const buffer = Buffer.from(await file.arrayBuffer());
      console.log('[upload] buffer read', {
        filename: file.name,
        bufferBytes: buffer.length,
        // First 4 bytes tell you a lot at a glance — `%PDF` for valid PDF,
        // `PK..` for docx/zip, etc. Useful when a "PDF" upload turns out
        // to be HTML or an error page.
        magicHex: buffer.slice(0, 8).toString('hex'),
        magicAscii: buffer.slice(0, 8).toString('ascii').replace(/[^\x20-\x7e]/g, '.')
      });

      // STEP 3: extract text. PDFs go through pdf-parse — common failure
      // modes here: image-only PDFs (scanned docs), encrypted PDFs,
      // malformed PDFs that pdf-parse throws on.
      const extractStart = Date.now();
      const extracted = await extract(buffer, file.name, ct);
      console.log('[upload] extracted', {
        filename: file.name,
        ms: Date.now() - extractStart,
        detectedMime: extracted.detectedContentType,
        title: extracted.title,
        textLength: extracted.text?.length || 0,
        textPreview: (extracted.text || '').slice(0, 120).replace(/\s+/g, ' ').trim()
      });

      if (!extracted.text || extracted.text.trim().length < 10) {
        console.warn('[upload] REJECT — extracted text empty/too short', {
          filename: file.name,
          textLength: extracted.text?.length || 0,
          hint: ct === 'application/pdf'
            ? 'image-only / scanned PDFs need OCR — try a text-based PDF'
            : 'file may be empty, encrypted, or unparseable'
        });
        results.push({
          filename: file.name,
          ok: false,
          error: 'Extracted text is empty or too short. Is the file readable / not image-only?'
        });
        continue;
      }

      // STEP 3.5: break up extra-long tokens before indexing.
      // Azure AI Search's default Lucene analyzer rejects single tokens
      // longer than 128 chars with "Command token too long: 128" — common
      // for PDFs that stitch words together (e.g. table cells with no
      // spaces, long URLs, base64 fragments). Insert a space every 100
      // chars in any non-whitespace run that long. Also applied to the
      // title to be safe.
      const safeText = breakLongTokens(extracted.text, 100);
      const safeTitle = breakLongTokens(extracted.title.slice(0, 256), 100);
      if (safeText.length !== extracted.text.length) {
        console.log('[upload] broke long tokens', {
          filename: file.name,
          before: extracted.text.length,
          after: safeText.length,
          inserted: safeText.length - extracted.text.length
        });
      }

      const docId = randomUUID().replace(/-/g, '');
      // Path: docs/<dept>/<short-id>-<safe-original-name>. Mirrors the
      // seed docs layout (docs/hr/compensation-policy.md) so the portal
      // shows seeds and uploads side-by-side under the same dept folder.
      const safeName = sanitizeFilename(file.name);
      const blobName = safeName
        ? `docs/${department}/${docId.slice(0, 8)}-${safeName}`
        : `docs/${department}/${docId}${extOf(file.name) || '.bin'}`;

      // STEP 4: chunk
      const chunks = chunkText(safeText, 500, 50);
      console.log('[upload] chunked', {
        filename: file.name,
        chunkCount: chunks.length,
        avgChunkChars: chunks.length
          ? Math.round(chunks.reduce((s, c) => s + c.length, 0) / chunks.length)
          : 0
      });

      // STEP 5: embed (per-batch latency + token count is logged inside
      // embedBatch via svcLog).
      const vectors = await embedBatch(chunks);

      // STEP 6: upload original blob (latency logged by uploadBlob via svcLog).
      console.log('[upload] uploading blob', {
        filename: file.name,
        blobName,
        contentType: ct
      });
      await uploadBlob({
        blobName,
        buffer,
        contentType: ct,
        metadata: {
          uploader_oid: user.oid,
          allowed_groups: requestedGroups.join(','),
          original_filename: encodeURIComponent(file.name),
          title: encodeURIComponent(safeTitle),
          department: encodeURIComponent(department)
        }
      });

      // STEP 7: stage chunk docs for the batched Search index push below.
      // allowedUsers always includes the uploader so they retain access
      // even if they later leave one of the chosen groups.
      chunks.forEach((c, i) => {
        indexBatch.push({
          id: `upload-${docId}-${i}`,
          content: c,
          contentVector: vectors[i],
          title: safeTitle,
          allowedGroups: requestedGroups,
          allowedUsers: [user.oid],
          department,
          uploader_oid: user.oid,
          blobName
        });
      });

      console.log('[upload] file OK', {
        filename: file.name,
        docId,
        title: safeTitle,
        chunks: chunks.length,
        blobName
      });

      results.push({
        filename: file.name,
        ok: true,
        doc: {
          id: `upload-${docId}-0`,
          title: safeTitle,
          chunks: chunks.length,
          blobName
        }
      });
    } catch (e) {
      // FULL stack trace — message alone often hides where pdf-parse died.
      console.error('[upload] FAIL — unhandled error', {
        filename: file.name,
        contentType: ct,
        error: (e as Error).message,
        stack: (e as Error).stack
      });
      results.push({ filename: file.name, ok: false, error: (e as Error).message });
    }
  }

  // ---------- Push chunks to Azure AI Search in batches of 50 ----------
  if (indexBatch.length > 0) {
    console.log('[upload] indexing', {
      totalChunks: indexBatch.length,
      batchSize: 50
    });
    const client = getSearchClient();
    const BATCH = 50;
    for (let i = 0; i < indexBatch.length; i += BATCH) {
      // SDK type narrows to the indexed type; the runtime accepts plain objects.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const slice = indexBatch.slice(i, i + BATCH) as any;
      const batchIdx = Math.floor(i / BATCH);
      try {
        const t0 = Date.now();
        const result = await client.uploadDocuments(slice);
        const fails = result.results.filter((r) => !r.succeeded);
        console.log('[upload] index batch', {
          batchIdx,
          size: slice.length,
          succeeded: result.results.length - fails.length,
          failed: fails.length,
          ms: Date.now() - t0
        });
        if (fails.length > 0) {
          console.warn('[upload] index batch had per-doc failures', {
            batchIdx,
            failures: fails.map((f) => ({ key: f.key, errorMessage: f.errorMessage }))
          });
        }
      } catch (e) {
        // If indexing fails after blob is written, surface a partial-failure
        // error. Operator can re-run /api/upload — same blobName is idempotent
        // (Azure Blob upserts) and uploadDocuments upserts by id too.
        console.error('[upload] index batch THREW — partial failure', {
          batchIdx,
          error: (e as Error).message,
          stack: (e as Error).stack
        });
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
