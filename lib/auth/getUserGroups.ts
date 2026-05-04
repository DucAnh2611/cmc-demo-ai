import { svcLog } from '@/lib/devLog';

type CacheEntry = { groups: string[]; expiresAt: number };
const cache = new Map<string, CacheEntry>();
const TTL_MS = 5 * 60 * 1000;

interface GraphMemberOfResponse {
  value: Array<{ '@odata.type': string; id: string }>;
  '@odata.nextLink'?: string;
}

export async function getUserGroups(accessToken: string, cacheKey?: string): Promise<string[]> {
  const key = cacheKey || accessToken.slice(-32);
  const now = Date.now();
  const cached = cache.get(key);
  if (cached && cached.expiresAt > now) {
    svcLog({
      service: 'graph',
      op: '/me/transitiveMemberOf',
      details: `${cached.groups.length} groups · CACHED`
    });
    return cached.groups;
  }

  const groups: string[] = [];
  let url: string | undefined =
    'https://graph.microsoft.com/v1.0/me/transitiveMemberOf?$select=id&$top=200';

  const t0 = Date.now();
  while (url) {
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        ConsistencyLevel: 'eventual'
      }
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Graph error ${res.status}: ${body}`);
    }
    const data = (await res.json()) as GraphMemberOfResponse;
    for (const obj of data.value) {
      if (obj['@odata.type'] === '#microsoft.graph.group') {
        groups.push(obj.id);
      }
    }
    url = data['@odata.nextLink'];
  }

  cache.set(key, { groups, expiresAt: now + TTL_MS });
  svcLog({
    service: 'graph',
    op: '/me/transitiveMemberOf',
    details: `${groups.length} groups · LIVE`,
    ms: Date.now() - t0
  });
  return groups;
}

export function clearGroupsCache() {
  cache.clear();
}
