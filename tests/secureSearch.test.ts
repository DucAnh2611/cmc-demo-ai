import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the embedder before importing secureSearch (which imports it transitively).
vi.mock('@/lib/search/embedder', () => ({
  embedText: vi.fn(async () => Array(1536).fill(0.01)),
  embedBatch: vi.fn(async (xs: string[]) => xs.map(() => Array(1536).fill(0.01)))
}));

// Mock the @azure/search-documents SDK so the test runs without a live Azure resource.
const fakeDocs: Array<{ id: string; title: string; allowedGroups: string[]; department: string; content: string }> = [
  { id: 'hr-1', title: 'Q3 HR Compensation Policy', allowedGroups: ['HR'], department: 'hr', content: 'salary bands and bonus' },
  { id: 'hr-2', title: 'Employee Handbook 2026', allowedGroups: ['HR'], department: 'hr', content: 'PTO and remote work' },
  { id: 'fin-1', title: 'Q3 Financial Statement', allowedGroups: ['FIN'], department: 'finance', content: 'revenue and margin' },
  { id: 'fin-2', title: 'Vendor Payment Process', allowedGroups: ['FIN'], department: 'finance', content: 'AP approval chain' },
  { id: 'pub-1', title: 'Company Mission and Values', allowedGroups: ['PUB'], department: 'public', content: 'mission and values' },
  { id: 'pub-2', title: 'IT Acceptable Use Policy', allowedGroups: ['PUB'], department: 'public', content: 'devices and network' }
];

vi.mock('@azure/search-documents', () => {
  function parseSearchInList(filter: string): string[] | null {
    const m = /search\.in\(g, '([^']*)'(?:, '([^']*)')?\)/.exec(filter);
    if (!m) return null;
    const list = m[1];
    const sep = m[2] || ',';
    return list.split(sep).filter(Boolean);
  }
  class SearchClient {
    constructor(public endpoint: string, public index: string, public cred: unknown) {}
    async search(_q: unknown, opts: { filter?: string; top?: number }) {
      const allowed = parseSearchInList(opts.filter || '') || [];
      const matched = fakeDocs.filter((d) => d.allowedGroups.some((g) => allowed.includes(g)));
      const top = opts.top ?? 5;
      const slice = matched.slice(0, top);
      return {
        async *[Symbol.asyncIterator]() {
          for (const d of slice) yield { document: d, score: 1 };
        },
        results: {
          async *[Symbol.asyncIterator]() {
            for (const d of slice) yield { document: d, score: 1 };
          }
        }
      };
    }
  }
  class AzureKeyCredential {
    constructor(public key: string) {}
  }
  return { SearchClient, AzureKeyCredential };
});

beforeEach(() => {
  process.env.AZURE_SEARCH_ENDPOINT = 'https://fake.search.windows.net';
  process.env.AZURE_SEARCH_API_KEY = 'fake-key';
  process.env.AZURE_SEARCH_INDEX_NAME = 'secure-docs-index';
  process.env.AZURE_OPENAI_ENDPOINT = 'https://fake.openai.azure.com';
  process.env.AZURE_OPENAI_API_KEY = 'fake-key';
});

describe('buildGroupFilter', () => {
  it('produces null for empty groups', async () => {
    const { buildGroupFilter } = await import('@/lib/search/secureSearch');
    expect(buildGroupFilter([])).toBeNull();
  });

  it('escapes single quotes in group ids', async () => {
    const { buildGroupFilter } = await import('@/lib/search/secureSearch');
    const f = buildGroupFilter(["abc'def", 'plain']);
    expect(f).toContain("abc''def");
    expect(f).toContain('plain');
    expect(f).toContain('search.in(g,');
  });
});

describe('secureSearch ACL enforcement', () => {
  it('user without HR group does NOT see HR docs', async () => {
    const { secureSearch } = await import('@/lib/search/secureSearch');
    const results = await secureSearch('show me compensation policy', ['FIN', 'PUB']);
    const titles = results.map((r) => r.title);
    expect(titles).not.toContain('Q3 HR Compensation Policy');
    expect(titles).not.toContain('Employee Handbook 2026');
    // but should include finance + public
    expect(titles).toEqual(expect.arrayContaining(['Q3 Financial Statement']));
  });

  it('user with HR group sees HR docs', async () => {
    const { secureSearch } = await import('@/lib/search/secureSearch');
    const results = await secureSearch('show me compensation policy', ['HR', 'PUB']);
    const titles = results.map((r) => r.title);
    expect(titles).toEqual(expect.arrayContaining(['Q3 HR Compensation Policy']));
  });

  it('user with no groups sees nothing', async () => {
    const { secureSearch } = await import('@/lib/search/secureSearch');
    const results = await secureSearch('anything', []);
    expect(results).toEqual([]);
  });
});
