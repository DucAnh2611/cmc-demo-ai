// MUST be first import — populates process.env before lib modules read it.
import '../lib/loadEnv';
import fs from 'node:fs/promises';
import { isBlobConfigured, uploadBlob } from '../lib/storage/blobClient';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import matter from 'gray-matter';
import { SearchIndexClient, AzureKeyCredential, type SearchIndex } from '@azure/search-documents';
import { embedBatch } from '../lib/search/embedder';
import { getSearchClient } from '../lib/search/secureSearch';
import { chunkText } from '../lib/utils/chunker';

const SEARCH_ENDPOINT = process.env.AZURE_SEARCH_ENDPOINT || '';
const SEARCH_KEY = process.env.AZURE_SEARCH_API_KEY || '';
const INDEX_NAME = process.env.AZURE_SEARCH_INDEX_NAME || 'secure-docs-index';

const GROUP_PLACEHOLDERS: Record<string, string> = {
  GROUP_HR_ID: process.env.GROUP_HR_ID || 'GROUP_HR_ID',
  GROUP_FINANCE_ID: process.env.GROUP_FINANCE_ID || 'GROUP_FINANCE_ID',
  GROUP_PUBLIC_ID: process.env.GROUP_PUBLIC_ID || 'GROUP_PUBLIC_ID'
};

function resolveGroupIds(allowedGroups: string[]): string[] {
  return allowedGroups.map((g) => GROUP_PLACEHOLDERS[g] ?? g);
}

const indexSchema: SearchIndex = {
  name: INDEX_NAME,
  fields: [
    { name: 'id', type: 'Edm.String', key: true, filterable: true },
    { name: 'content', type: 'Edm.String', searchable: true, analyzerName: 'standard.lucene' },
    {
      name: 'contentVector',
      type: 'Collection(Edm.Single)',
      searchable: true,
      vectorSearchDimensions: 1536,
      vectorSearchProfileName: 'default-profile'
    },
    { name: 'title', type: 'Edm.String', searchable: true, filterable: true },
    { name: 'sourceUrl', type: 'Edm.String' },
    { name: 'allowedGroups', type: 'Collection(Edm.String)', filterable: true },
    { name: 'allowedUsers', type: 'Collection(Edm.String)', filterable: true },
    { name: 'department', type: 'Edm.String', filterable: true, facetable: true },
    // Added for the upload feature — uploaded chunks carry the uploader's
    // Entra `oid` and the Blob Storage object name. Both are filterable so
    // we can show "my uploads" and resolve a chunk back to its source blob.
    { name: 'uploader_oid', type: 'Edm.String', filterable: true },
    { name: 'blobName', type: 'Edm.String' }
  ],
  vectorSearch: {
    algorithms: [{ name: 'hnsw-default', kind: 'hnsw' }],
    profiles: [{ name: 'default-profile', algorithmConfigurationName: 'hnsw-default' }]
  }
};

async function ensureIndex(): Promise<void> {
  const adminClient = new SearchIndexClient(SEARCH_ENDPOINT, new AzureKeyCredential(SEARCH_KEY));
  // createOrUpdateIndex lets us ADD new fields (e.g. uploader_oid, blobName)
  // to an existing index in-place — Azure AI Search permits adding optional
  // fields without dropping data. It still rejects breaking changes
  // (renames/type changes), which is what we want.
  try {
    await adminClient.createOrUpdateIndex(indexSchema);
    console.log(`[index] '${INDEX_NAME}' is up to date (created or schema updated)`);
  } catch (e) {
    console.error(`[index] Failed to create/update '${INDEX_NAME}':`, (e as Error).message);
    throw e;
  }
}

interface DocFile {
  filePath: string;
  department: string;
  title: string;
  allowedGroups: string[];
  allowedUsers: string[];
  sourceUrl?: string;
  /** Body text only (frontmatter stripped) — fed to the chunker. */
  content: string;
  /** Full file contents including frontmatter — used to populate the
   *  Blob Storage copy so the "Download original" button serves the
   *  exact source-of-truth file the developer wrote. */
  rawContent: string;
}

async function readSampleDocs(rootDir: string): Promise<DocFile[]> {
  const out: DocFile[] = [];
  const departments = await fs.readdir(rootDir, { withFileTypes: true });
  for (const dept of departments) {
    if (!dept.isDirectory()) continue;
    const deptDir = path.join(rootDir, dept.name);
    const files = await fs.readdir(deptDir);
    for (const f of files) {
      if (!f.endsWith('.md')) continue;
      const fp = path.join(deptDir, f);
      const raw = await fs.readFile(fp, 'utf8');
      const { data, content } = matter(raw);
      const allowedGroups = (data.allowedGroups as string[] | undefined) || [];
      const allowedUsers = (data.allowedUsers as string[] | undefined) || [];
      out.push({
        filePath: fp,
        department: dept.name,
        title: (data.title as string) || f.replace(/\.md$/, ''),
        allowedGroups,
        allowedUsers,
        sourceUrl: data.sourceUrl as string | undefined,
        content: content.trim(),
        rawContent: raw
      });
    }
  }
  return out;
}

async function main() {
  if (!SEARCH_ENDPOINT || !SEARCH_KEY) {
    // Exit 0 (not 1) so this script can run as a `predev` hook without
    // blocking `next dev` when Azure isn't configured yet.
    console.warn('[index] AZURE_SEARCH_ENDPOINT / AZURE_SEARCH_API_KEY missing in .env.local — skipping index sync.');
    return;
  }

  const force = process.argv.includes('--force');

  await ensureIndex();

  const here = path.dirname(fileURLToPath(import.meta.url));
  const sampleDir = path.resolve(here, '..', 'sample-docs');
  const docs = await readSampleDocs(sampleDir);
  console.log(`[index] read ${docs.length} sample doc(s) from ${sampleDir}`);

  type IndexDoc = {
    id: string;
    content: string;
    contentVector: number[];
    title: string;
    sourceUrl?: string;
    allowedGroups: string[];
    allowedUsers: string[];
    department: string;
    blobName?: string;
  };
  type Pending = Omit<IndexDoc, 'contentVector'>;

  // Compute prospective chunks WITHOUT embedding yet — embedding is the
  // expensive step. We want to embed only the chunks that don't already
  // exist in Azure.
  const pending: Pending[] = [];
  // Track each doc's seed blob (one entry per file, not per chunk) so we
  // can mirror the originals into Blob Storage alongside the index.
  type SeedBlob = {
    blobName: string;
    body: string;
    title: string;
    department: string;
    originalFilename: string;
  };
  const seedBlobs: SeedBlob[] = [];

  for (const doc of docs) {
    const chunks = chunkText(doc.content, 500, 50);
    const resolvedGroups = resolveGroupIds(doc.allowedGroups);
    const filename = path.basename(doc.filePath);
    const baseId = path
      .basename(doc.filePath, '.md')
      .replace(/[^a-zA-Z0-9_-]/g, '-');

    // Deterministic Blob path: docs/<dept>/<filename>.md. Re-runs are
    // idempotent (uploadBlob upserts) and the path lays out cleanly in
    // the Azure portal as "docs > hr > compensation-policy.md" etc.
    // The chunk's `blobName` field stores this exact path, so the search
    // index (and any consumer of the chunk) knows how to retrieve the
    // original file via /api/source/[id]/raw, which streams the blob.
    const blobName = `docs/${doc.department}/${filename}`;

    if (isBlobConfigured()) {
      seedBlobs.push({
        blobName,
        body: doc.rawContent,
        title: doc.title,
        department: doc.department,
        originalFilename: filename
      });
    }

    chunks.forEach((c, i) => {
      pending.push({
        id: `${doc.department}-${baseId}-${i}`,
        content: c,
        title: doc.title,
        sourceUrl: doc.sourceUrl,
        allowedGroups: resolvedGroups,
        allowedUsers: doc.allowedUsers,
        department: doc.department,
        blobName: isBlobConfigured() ? blobName : undefined
      });
    });
  }

  // Mirror the original markdown files into Blob Storage. One blob per
  // source file (regardless of chunk count). Skipped silently when no
  // connection string is set — the demo still works in index-only mode.
  if (isBlobConfigured() && seedBlobs.length > 0) {
    console.log(`[index] mirroring ${seedBlobs.length} seed file(s) to Blob Storage…`);
    for (const sb of seedBlobs) {
      await uploadBlob({
        blobName: sb.blobName,
        buffer: Buffer.from(sb.body, 'utf8'),
        contentType: 'text/markdown; charset=utf-8',
        metadata: {
          title: encodeURIComponent(sb.title.slice(0, 256)),
          department: sb.department,
          original_filename: encodeURIComponent(sb.originalFilename),
          seed: 'true'
        }
      });
    }
    console.log(`[index] seed mirror complete`);
  }

  const client = getSearchClient();

  // List existing chunk IDs in the Azure index so we can skip ones that
  // are already there. Sync-style: Azure is the source of truth; we only
  // upload local chunks that aren't represented yet.
  const existingIds = new Set<string>();
  if (!force) {
    const results = await client.search('*', { select: ['id'], top: 1000 });
    for await (const item of results.results) {
      const d = item.document as { id: string };
      existingIds.add(d.id);
    }
  }

  const toUpload = force ? pending : pending.filter((p) => !existingIds.has(p.id));
  const skipped = pending.length - toUpload.length;

  console.log(
    `[index] Azure has ${existingIds.size} chunk(s); ` +
      `local has ${pending.length}; ` +
      `to upload: ${toUpload.length}` +
      (skipped > 0 ? ` (skipping ${skipped} already in index)` : '') +
      (force ? ' [--force: re-uploading everything]' : '')
  );

  if (toUpload.length === 0) {
    console.log('[index] up to date — nothing to do');
    return;
  }

  // Embed only the chunks that need uploading. Saves AOAI calls on re-runs.
  const vectors = await embedBatch(toUpload.map((p) => p.content));
  const indexDocs: IndexDoc[] = toUpload.map((p, i) => ({
    ...p,
    contentVector: vectors[i]
  }));

  for (const d of indexDocs) {
    console.log(`[index] + ${d.id} (${d.department}, groups: ${d.allowedGroups.join(',')})`);
  }

  const BATCH = 50;
  for (let i = 0; i < indexDocs.length; i += BATCH) {
    const batch = indexDocs.slice(i, i + BATCH) as any;
    const result = await client.uploadDocuments(batch);
    const fails = result.results.filter((r) => !r.succeeded);
    if (fails.length) {
      console.error(`[index] batch ${i / BATCH} failures:`, fails);
    }
  }

  console.log(`[index] done — uploaded ${indexDocs.length} new chunk(s)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
