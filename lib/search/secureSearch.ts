import { SearchClient, AzureKeyCredential } from '@azure/search-documents';
import { embedText } from './embedder';

export interface SearchableChunk {
  id: string;
  content: string;
  title: string;
  sourceUrl?: string;
  department?: string;
  allowedGroups?: string[];
  allowedUsers?: string[];
  contentVector?: number[];
  /** Set on chunks that originated from /api/upload — points back to the
   * Azure Blob holding the original file (PDF/DOCX/etc.). */
  blobName?: string;
  /** Entra `oid` of the uploader, for "my uploads" filters and audit. */
  uploader_oid?: string;
}

export interface RetrievedChunk {
  id: string;
  content: string;
  title: string;
  sourceUrl?: string;
  department?: string;
  /** Returned so callers can perform a final-mile ACL re-check before
   * passing chunks to the LLM. The Search filter already enforces this,
   * but reading it back lets callers verify defense-in-depth. */
  allowedGroups?: string[];
  score?: number;
}

const endpoint = process.env.AZURE_SEARCH_ENDPOINT || '';
const apiKey = process.env.AZURE_SEARCH_API_KEY || '';
const indexName = process.env.AZURE_SEARCH_INDEX_NAME || 'secure-docs-index';

let _client: SearchClient<SearchableChunk> | null = null;

export function getSearchClient(): SearchClient<SearchableChunk> {
  if (_client) return _client;
  if (!endpoint || !apiKey) {
    throw new Error('AZURE_SEARCH_ENDPOINT and AZURE_SEARCH_API_KEY must be set');
  }
  _client = new SearchClient<SearchableChunk>(endpoint, indexName, new AzureKeyCredential(apiKey));
  return _client;
}

/** Build a security-trimming OData filter for `allowedGroups`. Returns `null` for users with zero groups (caller should short-circuit and return []). */
export function buildGroupFilter(userGroups: string[]): string | null {
  if (!userGroups || userGroups.length === 0) return null;
  // Escape any single quote and join with comma — exact format expected by `search.in`.
  const escaped = userGroups.map((g) => g.replace(/'/g, "''"));
  const list = escaped.join(',');
  return `allowedGroups/any(g: search.in(g, '${list}', ','))`;
}

export interface SecureSearchOptions {
  top?: number;
  /** When true, returns 0 results instead of throwing if the user has no groups. */
  allowEmpty?: boolean;
}

export async function secureSearch(
  query: string,
  userGroups: string[],
  opts: SecureSearchOptions = {}
): Promise<RetrievedChunk[]> {
  const top = opts.top ?? 5;

  const filter = buildGroupFilter(userGroups);
  if (!filter) {
    if (opts.allowEmpty) return [];
    return [];
  }

  const vector = await embedText(query);
  const client = getSearchClient();

  const results = await client.search(undefined, {
    filter,
    top,
    select: ['id', 'content', 'title', 'sourceUrl', 'department', 'allowedGroups'],
    vectorSearchOptions: {
      queries: [
        {
          kind: 'vector',
          vector,
          kNearestNeighborsCount: top,
          fields: ['contentVector']
        }
      ]
    }
  });

  const chunks: RetrievedChunk[] = [];
  for await (const item of results.results) {
    const d = item.document as SearchableChunk;
    chunks.push({
      id: d.id,
      content: d.content,
      title: d.title,
      sourceUrl: d.sourceUrl,
      department: d.department,
      allowedGroups: d.allowedGroups,
      score: item.score
    });
  }
  return chunks;
}
