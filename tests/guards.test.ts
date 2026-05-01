import { describe, it, expect, vi, beforeEach } from 'vitest';

// Tripwire tests for the four ACL-principle guards (see §"Things that would
// violate the principle" in the demo guide). If any of these break, a future
// commit silently regressed a security guard — investigate before merging.

describe('Guard #4: envGuard — sensitive env vars must not be NEXT_PUBLIC_', () => {
  const SENSITIVE = [
    'AZURE_SEARCH_API_KEY',
    'AZURE_OPENAI_API_KEY',
    'ANTHROPIC_API_KEY',
    'APPLICATIONINSIGHTS_CONNECTION_STRING'
  ];

  beforeEach(() => {
    for (const k of SENSITIVE) delete process.env[`NEXT_PUBLIC_${k}`];
    vi.resetModules();
  });

  it('passes when all sensitive vars are server-only', async () => {
    await expect(import('@/lib/envGuard')).resolves.toBeDefined();
  });

  for (const key of SENSITIVE) {
    it(`throws when ${key} is exposed via NEXT_PUBLIC_${key}`, async () => {
      process.env[`NEXT_PUBLIC_${key}`] = 'leak';
      vi.resetModules();
      await expect(import('@/lib/envGuard')).rejects.toThrow(new RegExp(`NEXT_PUBLIC_${key}`));
      delete process.env[`NEXT_PUBLIC_${key}`];
    });
  }
});

describe('Guard #3: getUserGroups cache key (Scenario E — dynamic permissions)', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('caches by token, so re-login (new token) busts the cache', async () => {
    let fetchCount = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => {
      fetchCount++;
      return {
        ok: true,
        json: async () => ({
          value: [{ '@odata.type': '#microsoft.graph.group', id: `group-${fetchCount}` }]
        }),
        text: async () => ''
      } as unknown as Response;
    });

    try {
      const mod = await import('@/lib/auth/getUserGroups');
      mod.clearGroupsCache();

      const tokenA = 'A'.repeat(100);
      const tokenB = 'B'.repeat(100);

      await mod.getUserGroups(tokenA);
      expect(fetchCount).toBe(1);

      // Same token — should hit cache, not re-fetch.
      await mod.getUserGroups(tokenA);
      expect(fetchCount).toBe(1);

      // Different token (simulates re-login) — cache miss, fresh Graph call.
      await mod.getUserGroups(tokenB);
      expect(fetchCount).toBe(2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
