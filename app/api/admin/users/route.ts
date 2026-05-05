import '@/lib/envGuard';
import { NextRequest } from 'next/server';
import { checkAdmin } from '@/lib/admin/requireAdmin';
import {
  listUsers,
  createUser,
  getGroupMembers,
  GraphError,
  type CreateUserInput
} from '@/lib/admin/graph';
import { auditLog } from '@/lib/audit/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/admin/users
 *
 * List all member users in the tenant. Gated on GROUP_APP_ADMINS_ID
 * membership; further gated by Graph itself (the signed-in user must
 * hold an Entra role with directory read permission).
 */
export async function GET(req: NextRequest) {
  const auth = await checkAdmin(req);
  if (!auth.ok) return new Response(auth.message, { status: auth.status });

  try {
    // Annotate each user with `isAppAdmin` (in GROUP_APP_ADMINS_ID) and
    // `isSystemAccount` (UPN contains the synthetic `#EXT#` marker —
    // tenant owner / B2B guests). The frontend uses these flags to hide
    // every mutation control on protected users; the corresponding
    // backend mutation routes also re-check via getUserProtection.
    const adminGroupId = (process.env.GROUP_APP_ADMINS_ID || '').trim();
    const [users, adminMembers] = await Promise.all([
      listUsers(auth.token),
      adminGroupId ? getGroupMembers(auth.token, adminGroupId).catch(() => []) : Promise.resolve([])
    ]);
    const adminIds = new Set(adminMembers.map((m) => m.id));
    const annotated = users.map((u) => ({
      ...u,
      isAppAdmin: adminIds.has(u.id),
      isSystemAccount: (u.userPrincipalName || '').includes('#EXT#')
    }));
    return Response.json({ users: annotated, count: annotated.length });
  } catch (e) {
    if (e instanceof GraphError) {
      // Graph 403 most commonly = "your account doesn't have a directory
      // role". Surface the Graph message verbatim so the operator can
      // tell whether they need to grant admin consent on the app, OR
      // assign the User Administrator role to their account.
      return new Response(e.message, { status: e.status });
    }
    return new Response(`Unexpected: ${(e as Error).message}`, { status: 500 });
  }
}

/**
 * POST /api/admin/users — create a user.
 *
 * Body: { userPrincipalName, displayName, password, mailNickname?, forceChangePasswordNextSignIn? }
 *
 * Common 4xx from Graph (re-surfaced verbatim):
 *   - 400 password doesn't meet policy
 *   - 400 UPN already in use
 *   - 403 caller missing User Administrator role
 */
export async function POST(req: NextRequest) {
  const auth = await checkAdmin(req);
  if (!auth.ok) return new Response(auth.message, { status: auth.status });

  let body: Partial<CreateUserInput>;
  try {
    body = (await req.json()) as Partial<CreateUserInput>;
  } catch {
    return new Response('Body must be valid JSON', { status: 400 });
  }

  // Minimal client-side validation — Graph also enforces all of this,
  // but we surface friendlier errors here.
  if (!body.userPrincipalName || typeof body.userPrincipalName !== 'string') {
    return new Response('userPrincipalName is required', { status: 400 });
  }
  if (!/.+@.+\..+/.test(body.userPrincipalName)) {
    return new Response('userPrincipalName must look like alice@yourtenant.onmicrosoft.com', { status: 400 });
  }
  if (!body.displayName || typeof body.displayName !== 'string') {
    return new Response('displayName is required', { status: 400 });
  }
  if (!body.password || typeof body.password !== 'string' || body.password.length < 8) {
    return new Response('password must be at least 8 characters', { status: 400 });
  }

  try {
    const created = await createUser(auth.token, body as CreateUserInput);
    await auditLog({
      userId: auth.user.oid,
      upn: auth.user.upn,
      query: `[admin:create-user] ${created.userPrincipalName}`,
      retrievedDocIds: [],
      retrievedTitles: [],
      responsePreview: `Admin ${auth.user.upn || auth.user.oid} created user ${created.userPrincipalName} (${created.id})`,
      groupCount: auth.groups.length,
      timestamp: new Date().toISOString()
    }).catch(() => {});
    return Response.json({ user: created }, { status: 201 });
  } catch (e) {
    if (e instanceof GraphError) return new Response(e.message, { status: e.status });
    return new Response(`Unexpected: ${(e as Error).message}`, { status: 500 });
  }
}
