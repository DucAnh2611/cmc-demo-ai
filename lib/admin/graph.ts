import { svcLog } from '@/lib/devLog';

/**
 * Microsoft Graph wrapper for the in-app admin panel. All calls are
 * delegated — they use the signed-in admin's bearer token, so Graph
 * enforces Entra role checks (e.g. "User Administrator") on top of the
 * app's OAuth scopes (`User.ReadWrite.All`, `Group.ReadWrite.All`).
 *
 * Why delegated and not application creds:
 *   - One less secret to manage (no client secret in env)
 *   - Audit trail in Entra logs shows the actual human who ran each
 *     action, not "the app" — much better for compliance
 *   - If the admin loses their Entra role, the in-app actions stop
 *     working immediately (no permission-drift)
 *
 * Phase 1 exposes only READ functions. Mutations land in later phases.
 */

const GRAPH = 'https://graph.microsoft.com/v1.0';

export interface GraphUser {
  id: string;
  displayName: string;
  userPrincipalName: string;
  mail?: string | null;
  jobTitle?: string | null;
  accountEnabled?: boolean;
}

export interface GraphGroup {
  id: string;
  displayName: string;
  description?: string | null;
  securityEnabled?: boolean;
  mailEnabled?: boolean;
  /** True for Microsoft 365 (unified) groups; we filter these OUT in the
   *  list call because only Security groups appear in the user's
   *  transitiveMemberOf claim used for RAG ACL. */
  groupTypes?: string[];
}

interface GraphErrorBody {
  error?: { code?: string; message?: string };
}

/**
 * Friendly Error subclass so callers can distinguish Graph 4xx (need to
 * surface the message to the user — usually means missing Entra role)
 * from network / unknown failures.
 */
export class GraphError extends Error {
  constructor(public status: number, public body: string) {
    const parsed = safeJson<GraphErrorBody>(body);
    const code = parsed?.error?.code ?? '';
    const detail = parsed?.error?.message ?? body.slice(0, 200);
    super(`Graph ${status}${code ? ` (${code})` : ''}: ${detail}`);
    this.name = 'GraphError';
  }
}

function safeJson<T>(s: string): T | null {
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
}

async function graphFetch(token: string, path: string, init: RequestInit = {}): Promise<unknown> {
  const url = path.startsWith('http') ? path : `${GRAPH}${path}`;
  const t0 = Date.now();
  const res = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      ConsistencyLevel: 'eventual',
      Accept: 'application/json',
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers || {})
    }
  });
  const status = res.status;
  // 204 No Content (typical for DELETE / PATCH) → return null
  let bodyText = '';
  if (status !== 204) bodyText = await res.text();
  svcLog({
    service: 'graph',
    op: `${init.method || 'GET'} ${path}`,
    details: `status ${status}`,
    ms: Date.now() - t0
  });
  if (!res.ok) throw new GraphError(status, bodyText);
  return bodyText ? JSON.parse(bodyText) : null;
}

interface GraphCollection<T> {
  value: T[];
  '@odata.nextLink'?: string;
}

/** Paginate through all pages of a Graph collection endpoint. */
async function paginate<T>(token: string, path: string, max = 1000): Promise<T[]> {
  const out: T[] = [];
  let next: string | undefined = path;
  while (next && out.length < max) {
    const data = (await graphFetch(token, next)) as GraphCollection<T>;
    out.push(...(data.value || []));
    next = data['@odata.nextLink'];
  }
  return out.slice(0, max);
}

// ---------- Users ----------

/**
 * List users in the tenant. Returns up to `max` (default 200) sorted by
 * displayName. Filters out guest accounts to keep the panel focused on
 * managed identities — the demo's whole point is internal ACL.
 */
export async function listUsers(token: string, max = 200): Promise<GraphUser[]> {
  // $filter + $orderby on /users requires Graph "advanced query":
  // ConsistencyLevel: eventual (sent by graphFetch) + $count=true.
  // Without $count=true the request fails with
  // "Request_UnsupportedQuery: Sorting not supported for current query."
  const path =
    `/users` +
    `?$select=id,displayName,userPrincipalName,mail,jobTitle,accountEnabled,userType` +
    `&$filter=userType eq 'Member'` +
    `&$orderby=displayName` +
    `&$count=true` +
    `&$top=200`;
  const users = await paginate<GraphUser & { userType?: string }>(token, path, max);
  return users.map(({ userType: _userType, ...u }) => u);
}

export async function getUser(token: string, id: string): Promise<GraphUser> {
  const u = (await graphFetch(
    token,
    `/users/${encodeURIComponent(id)}?$select=id,displayName,userPrincipalName,mail,jobTitle,accountEnabled`
  )) as GraphUser;
  return u;
}

/** Groups the user is a member of (transitive — includes nested). */
export async function getUserGroupsAdmin(token: string, id: string): Promise<GraphGroup[]> {
  // /users/{id}/transitiveMemberOf returns directoryObjects of mixed
  // types — filter to groups with $select for the fields we render.
  const path =
    `/users/${encodeURIComponent(id)}/transitiveMemberOf/microsoft.graph.group` +
    `?$select=id,displayName,description,securityEnabled,mailEnabled,groupTypes` +
    `&$top=200`;
  return paginate<GraphGroup>(token, path);
}

// ---------- Groups ----------

/**
 * List Security groups in the tenant (the only kind that drives RAG
 * ACL). Excludes Microsoft 365 (unified) groups — those don't appear in
 * the user's transitiveMemberOf claim and would clutter the picker.
 */
export async function listGroups(token: string, max = 200): Promise<GraphGroup[]> {
  // Same $count=true requirement as listUsers — see comment there.
  const path =
    `/groups` +
    `?$select=id,displayName,description,securityEnabled,mailEnabled,groupTypes` +
    `&$filter=securityEnabled eq true and mailEnabled eq false` +
    `&$orderby=displayName` +
    `&$count=true` +
    `&$top=200`;
  return paginate<GraphGroup>(token, path, max);
}

export async function getGroup(token: string, id: string): Promise<GraphGroup> {
  return (await graphFetch(
    token,
    `/groups/${encodeURIComponent(id)}?$select=id,displayName,description,securityEnabled,mailEnabled,groupTypes`
  )) as GraphGroup;
}

export async function getGroupMembers(token: string, id: string): Promise<GraphUser[]> {
  // microsoft.graph.user filter excludes nested groups & service principals.
  const path =
    `/groups/${encodeURIComponent(id)}/members/microsoft.graph.user` +
    `?$select=id,displayName,userPrincipalName,mail,jobTitle,accountEnabled` +
    `&$top=200`;
  return paginate<GraphUser>(token, path);
}

// ---------- Mutations ----------

export interface CreateUserInput {
  /** Full UPN, e.g. `alice@yourtenant.onmicrosoft.com`. */
  userPrincipalName: string;
  displayName: string;
  /** Initial password — must satisfy tenant password policy (8+ chars,
   *  upper/lower/digit/symbol). The Microsoft Graph default policy is
   *  enforced server-side; we surface the resulting error message. */
  password: string;
  /** When true (default), the user must change password on first login. */
  forceChangePasswordNextSignIn?: boolean;
  /** Mail nickname — Graph requires it. Defaults to the part before @. */
  mailNickname?: string;
}

/**
 * Create a new user in the tenant. Returns the freshly-created user
 * (incl. its new id). Caller is responsible for any subsequent group
 * assignment via addGroupMember.
 *
 * Common 4xx causes:
 *   - 400 password doesn't meet policy → message tells you which rule
 *   - 400 UPN already taken → unique constraint
 *   - 403 caller missing User Administrator role
 */
export async function createUser(token: string, input: CreateUserInput): Promise<GraphUser> {
  const body = {
    accountEnabled: true,
    displayName: input.displayName,
    userPrincipalName: input.userPrincipalName,
    mailNickname: input.mailNickname || input.userPrincipalName.split('@')[0],
    passwordProfile: {
      password: input.password,
      forceChangePasswordNextSignIn: input.forceChangePasswordNextSignIn ?? true
    }
  };
  return (await graphFetch(token, '/users', {
    method: 'POST',
    body: JSON.stringify(body)
  })) as GraphUser;
}

export interface UpdateUserInput {
  displayName?: string;
  /** `null` to clear, `string` to set, omit for no change. */
  jobTitle?: string | null;
  accountEnabled?: boolean;
}

/**
 * Patch user fields. Only the keys actually present in `patch` are
 * sent — partial updates supported.
 *
 * Empty-string normalisation: Microsoft Graph PATCH semantics are
 *   omit  → no change
 *   value → set
 *   null  → clear
 * Sending an empty string for a nullable property (e.g. jobTitle) is
 * rejected with `Request_BadRequest: Invalid value specified for
 * property 'jobTitle' of resource 'User'`. The frontend naturally sends
 * `""` when the admin clears a text input — we translate that to `null`
 * here so callers don't need to know the Graph quirk.
 */
export async function updateUser(
  token: string,
  id: string,
  patch: UpdateUserInput
): Promise<void> {
  const body: Record<string, unknown> = { ...patch };
  if (body.jobTitle === '') body.jobTitle = null;
  await graphFetch(token, `/users/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(body)
  });
}

/**
 * Delete a user. Microsoft Graph soft-deletes — the user lands in the
 * Deleted Users blade and is recoverable for 30 days. Permanent delete
 * is a separate API we don't expose here.
 */
export async function deleteUser(token: string, id: string): Promise<void> {
  await graphFetch(token, `/users/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

/**
 * Well-known Microsoft Graph method ID for the "password" authentication
 * method. Hard-coded by Microsoft — every user has exactly one password
 * method with this ID (or none, for passwordless accounts).
 *
 * Reference: https://learn.microsoft.com/graph/api/passwordauthenticationmethod-resetpassword
 */
const PASSWORD_AUTH_METHOD_ID = '28c10230-6103-485e-b985-444c60001490';

/**
 * Reset a user's password.
 *
 * Two endpoints exist; we try the newer one first.
 *
 *   1. NEW (preferred):
 *      `POST /users/{id}/authentication/methods/{passwordMethodId}/resetPassword`
 *      - Required scope: `UserAuthenticationMethod.ReadWrite.All`
 *      - Required role: User Administrator (non-admin targets) or
 *        Privileged Authentication Administrator (any target)
 *      - Body: `{ "newPassword": "..." }`
 *      - Returns 202 Accepted with a Location header pointing to a
 *        resetPasswordOperationResult resource (we don't poll — the
 *        202 means Graph has accepted the operation)
 *      - Note: the new API does NOT take a forceChangeNextSignIn flag.
 *        Admin-reset semantics always force change on next sign-in.
 *
 *   2. LEGACY fallback:
 *      `PATCH /users/{id}` with `passwordProfile`
 *      - Required scope: `User.ReadWrite.All`
 *      - Honours `forceChangePasswordNextSignIn`
 *      - Microsoft has been disabling this path tenant-by-tenant
 *        through 2024-2025. New tenants reject it with 403 even when
 *        the caller has the right role.
 *
 * Order: try new first. If it 404s (endpoint not provisioned in this
 * tenant — rare on modern tenants but possible on very old ones), fall
 * back to legacy. Other 4xx (400 password policy, 403 missing role) →
 * surface verbatim to the caller; falling back wouldn't help and would
 * mask the real problem.
 *
 * The `forceChangePasswordNextSignIn` parameter is honoured ONLY on the
 * legacy path. On the new path it's effectively always true (admin
 * reset = user must change at next sign-in). Kept in the signature for
 * back-compat with the route handler.
 */
export async function resetUserPassword(
  token: string,
  id: string,
  newPassword: string,
  forceChangePasswordNextSignIn = true
): Promise<void> {
  // Step 1 — try the new Authentication Methods API.
  try {
    await graphFetch(
      token,
      `/users/${encodeURIComponent(id)}/authentication/methods/${PASSWORD_AUTH_METHOD_ID}/resetPassword`,
      {
        method: 'POST',
        body: JSON.stringify({ newPassword })
      }
    );
    return;
  } catch (e) {
    // Only fall back on 404 — anything else is a real failure (bad
    // password, missing role, account has no password method, etc.)
    // and the legacy path won't help.
    if (!(e instanceof GraphError) || e.status !== 404) {
      throw e;
    }
  }

  // Step 2 — legacy fallback for tenants where the new API isn't
  // available. Same authorization rules; caller may still 403 if the
  // tenant has migrated away from this path entirely.
  await graphFetch(token, `/users/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify({
      passwordProfile: {
        password: newPassword,
        forceChangePasswordNextSignIn
      }
    })
  });
}

export interface CreateGroupInput {
  displayName: string;
  description?: string;
  /** Mail nickname is required by Graph even for non-mail Security groups.
   *  Defaults to displayName lowercased + dashed. */
  mailNickname?: string;
}

/**
 * Create a new Security group. Forces securityEnabled=true, mailEnabled
 * =false, groupTypes=[] — these are the settings that make the group
 * appear in transitiveMemberOf claims (i.e. usable for our RAG ACL).
 * Microsoft 365 / Unified groups do NOT show up in those claims, so
 * we never let the form create one.
 */
export async function createGroup(token: string, input: CreateGroupInput): Promise<GraphGroup> {
  const mailNickname =
    input.mailNickname || input.displayName.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 60);
  const body = {
    displayName: input.displayName,
    description: input.description || undefined,
    mailNickname,
    securityEnabled: true,
    mailEnabled: false,
    groupTypes: [] // Security group, NOT Microsoft 365
  };
  return (await graphFetch(token, '/groups', {
    method: 'POST',
    body: JSON.stringify(body)
  })) as GraphGroup;
}

export interface UpdateGroupInput {
  displayName?: string;
  /** `null` to clear, `string` to set, omit for no change. */
  description?: string | null;
}

/**
 * Same empty-string-→-null normalisation as updateUser. Without it,
 * clearing a description from the UI becomes:
 *   PATCH /groups/{id} { "description": "" }
 * which Graph rejects with `Invalid value specified for property
 * 'description' of resource 'Group'`.
 */
export async function updateGroup(
  token: string,
  id: string,
  patch: UpdateGroupInput
): Promise<void> {
  const body: Record<string, unknown> = { ...patch };
  if (body.description === '') body.description = null;
  await graphFetch(token, `/groups/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(body)
  });
}

/**
 * Delete a group. Like users, groups are soft-deleted for 30 days.
 */
export async function deleteGroup(token: string, id: string): Promise<void> {
  await graphFetch(token, `/groups/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

/**
 * Add a user to a group. Uses the $ref endpoint — Graph wants a
 * directoryObject reference, not the user payload itself.
 */
export async function addGroupMember(
  token: string,
  groupId: string,
  userId: string
): Promise<void> {
  await graphFetch(token, `/groups/${encodeURIComponent(groupId)}/members/$ref`, {
    method: 'POST',
    body: JSON.stringify({
      '@odata.id': `https://graph.microsoft.com/v1.0/directoryObjects/${userId}`
    })
  });
}

/** Remove a user from a group. */
export async function removeGroupMember(
  token: string,
  groupId: string,
  userId: string
): Promise<void> {
  await graphFetch(
    token,
    `/groups/${encodeURIComponent(groupId)}/members/${encodeURIComponent(userId)}/$ref`,
    { method: 'DELETE' }
  );
}

// ---------- Misc helpers ----------

/** Member count via Graph $count endpoint. Cheap; safe to call per group. */
export async function getGroupMemberCount(token: string, id: string): Promise<number | null> {
  try {
    const url = `${GRAPH}/groups/${encodeURIComponent(id)}/members/$count`;
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        ConsistencyLevel: 'eventual'
      }
    });
    if (!res.ok) return null;
    const txt = (await res.text()).trim();
    const n = Number(txt);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}
