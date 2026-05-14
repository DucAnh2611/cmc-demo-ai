import { getUploadsContainer, isBlobConfigured } from '@/lib/storage/blobClient';
import { randomBytes } from 'node:crypto';

/**
 * Access policy for the /flow documentation page.
 *
 * Three modes:
 *   - `public`            : anyone can read, signed in or not. The
 *                           plain `/flow` URL works for everyone.
 *   - `anyone-with-link`  : a unique share token must be present in the
 *                           URL (`/flow?t=<token>`). Only that exact
 *                           URL grants access. The plain `/flow` URL
 *                           denies in this mode. The token is generated
 *                           the first time the admin saves the policy
 *                           in this mode, and can be regenerated to
 *                           revoke the old link.
 *   - `restricted`        : caller's `oid` must be in `allowedUsers`,
 *                           OR caller must be a member of at least one
 *                           of the `allowedGroups`. Token is ignored.
 *
 * Admins always resolve to granted regardless of mode — same bypass
 * principle the ACL filter and sensitivity rules use.
 *
 * Storage: one JSON blob at `uploads/access/flow.json` in the existing
 * uploads container, cached in-process for 60 seconds. Admin mutations
 * call `invalidateFlowAccessCache()` so the next reader sees fresh
 * state on the same instance; cross-instance staleness is bounded by
 * the TTL.
 */

export type FlowAccessMode = 'public' | 'anyone-with-link' | 'restricted';

export interface FlowAccessPolicy {
  mode: FlowAccessMode;
  allowedGroups: string[];
  allowedUsers: string[];
  /** Random unguessable string used by `anyone-with-link` mode. Sent
   *  by the caller as `?t=<token>`. Empty when never generated; the
   *  PATCH endpoint generates a new one the first time the admin
   *  saves the policy in `anyone-with-link` mode. */
  linkToken: string;
  updatedBy: string;
  updatedAt: string;
}

/** Default at first install — preserves the prior demo behaviour
 *  (anyone who could reach the URL could see the doc) while adding a
 *  sign-in requirement consistent with the rest of the app. */
export const DEFAULT_FLOW_ACCESS: FlowAccessPolicy = {
  mode: 'anyone-with-link',
  allowedGroups: [],
  allowedUsers: [],
  linkToken: '',
  updatedBy: '',
  updatedAt: ''
};

const BLOB_NAME = 'access/flow.json';
const CACHE_TTL_MS = 60_000;

let _cache: { at: number; policy: FlowAccessPolicy } | null = null;

export function invalidateFlowAccessCache(): void {
  _cache = null;
}

export async function loadFlowAccess(force = false): Promise<FlowAccessPolicy> {
  const now = Date.now();
  if (!force && _cache && now - _cache.at < CACHE_TTL_MS) return _cache.policy;
  if (!isBlobConfigured()) {
    _cache = { at: now, policy: DEFAULT_FLOW_ACCESS };
    return DEFAULT_FLOW_ACCESS;
  }
  try {
    const container = await getUploadsContainer();
    const block = container.getBlockBlobClient(BLOB_NAME);
    if (!(await block.exists())) {
      _cache = { at: now, policy: DEFAULT_FLOW_ACCESS };
      return DEFAULT_FLOW_ACCESS;
    }
    const buf = await block.downloadToBuffer();
    const parsed = JSON.parse(buf.toString('utf8')) as Partial<FlowAccessPolicy>;
    const policy: FlowAccessPolicy = {
      mode: (parsed.mode as FlowAccessMode) || 'anyone-with-link',
      allowedGroups: Array.isArray(parsed.allowedGroups) ? parsed.allowedGroups : [],
      allowedUsers: Array.isArray(parsed.allowedUsers) ? parsed.allowedUsers : [],
      linkToken: typeof parsed.linkToken === 'string' ? parsed.linkToken : '',
      updatedBy: parsed.updatedBy || '',
      updatedAt: parsed.updatedAt || ''
    };
    _cache = { at: now, policy };
    return policy;
  } catch {
    // Fail open with defaults rather than 500-ing every visit to /flow.
    _cache = { at: now, policy: DEFAULT_FLOW_ACCESS };
    return DEFAULT_FLOW_ACCESS;
  }
}

/** 24-char URL-safe random token. Long enough to be unguessable
 *  (~138 bits of entropy), short enough to fit comfortably in a
 *  shareable URL. */
function newLinkToken(): string {
  return randomBytes(18).toString('base64url');
}

export interface SaveFlowAccessPatch {
  mode?: FlowAccessMode;
  allowedGroups?: string[];
  allowedUsers?: string[];
  /** Force a brand-new link token. Old token is invalidated. Only has
   *  effect when the resulting mode is `anyone-with-link`. */
  regenerateLink?: boolean;
}

export async function saveFlowAccess(
  patch: SaveFlowAccessPatch,
  updatedBy: string
): Promise<FlowAccessPolicy> {
  if (!isBlobConfigured()) {
    throw new Error('Blob storage not configured — cannot persist access policy');
  }
  const current = await loadFlowAccess(true);
  const nextMode = patch.mode || current.mode;
  if (!['public', 'anyone-with-link', 'restricted'].includes(nextMode)) {
    throw new Error(`Invalid mode: ${nextMode}`);
  }
  // Token lifecycle:
  //   - regenerateLink=true        → always mint a new token (admin
  //     explicitly clicked "Regenerate", which revokes the old URL).
  //   - mode=anyone-with-link AND
  //     no existing token           → mint one so the editor can show a
  //     shareable URL straight away on first save.
  //   - any other case              → preserve the existing token. We
  //     keep it across mode switches so an admin who toggles back to
  //     anyone-with-link doesn't accidentally restore a previously-
  //     intentionally-revoked link — instead they'll see the prior
  //     token and can decide to regenerate it.
  let linkToken = current.linkToken;
  if (patch.regenerateLink) {
    linkToken = newLinkToken();
  } else if (nextMode === 'anyone-with-link' && !linkToken) {
    linkToken = newLinkToken();
  }
  const next: FlowAccessPolicy = {
    mode: nextMode,
    allowedGroups: Array.isArray(patch.allowedGroups) ? patch.allowedGroups : current.allowedGroups,
    allowedUsers: Array.isArray(patch.allowedUsers) ? patch.allowedUsers : current.allowedUsers,
    linkToken,
    updatedBy,
    updatedAt: new Date().toISOString()
  };
  const container = await getUploadsContainer();
  const block = container.getBlockBlobClient(BLOB_NAME);
  await block.uploadData(Buffer.from(JSON.stringify(next, null, 2), 'utf8'), {
    blobHTTPHeaders: { blobContentType: 'application/json; charset=utf-8' }
  });
  invalidateFlowAccessCache();
  return next;
}

/** Outcome of a single access check. `reason` is set when not granted
 *  so the client can render the right state (sign-in / denied / share-
 *  link-missing). */
export interface FlowAccessDecision {
  granted: boolean;
  mode: FlowAccessMode;
  reason?: 'sign-in-required' | 'denied' | 'misconfigured' | 'invalid-link';
}

export interface FlowAccessContext {
  /** Caller oid, or undefined when the visitor isn't signed in. */
  oid?: string;
  /** Caller groups; empty array when unknown. */
  groupIds?: string[];
  /** Admin flag — admins always pass. */
  isAdmin?: boolean;
  /** Share-link token from the request URL (`?t=...`). Only consulted
   *  in `anyone-with-link` mode. */
  shareToken?: string;
}

/** Constant-time string compare to avoid leaking the token via timing
 *  attacks on the public check endpoint. */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function checkFlowAccess(
  policy: FlowAccessPolicy,
  ctx: FlowAccessContext
): FlowAccessDecision {
  if (ctx.isAdmin) return { granted: true, mode: policy.mode };

  switch (policy.mode) {
    case 'public':
      return { granted: true, mode: 'public' };

    case 'anyone-with-link': {
      // The plain `/flow` URL denies in this mode — only a request
      // carrying the right `?t=<token>` query gets through.
      const supplied = (ctx.shareToken || '').trim();
      if (!supplied || !policy.linkToken) {
        return { granted: false, mode: 'anyone-with-link', reason: 'invalid-link' };
      }
      if (!safeEqual(supplied, policy.linkToken)) {
        return { granted: false, mode: 'anyone-with-link', reason: 'invalid-link' };
      }
      return { granted: true, mode: 'anyone-with-link' };
    }

    case 'restricted': {
      if (!ctx.oid) {
        return { granted: false, mode: 'restricted', reason: 'sign-in-required' };
      }
      if (policy.allowedUsers.includes(ctx.oid)) {
        return { granted: true, mode: 'restricted' };
      }
      const callerGroups = new Set(ctx.groupIds || []);
      if (policy.allowedGroups.some((g) => callerGroups.has(g))) {
        return { granted: true, mode: 'restricted' };
      }
      // No allowedGroups + no allowedUsers + not admin = no one can read.
      if (policy.allowedGroups.length === 0 && policy.allowedUsers.length === 0) {
        return { granted: false, mode: 'restricted', reason: 'misconfigured' };
      }
      return { granted: false, mode: 'restricted', reason: 'denied' };
    }
  }
}
