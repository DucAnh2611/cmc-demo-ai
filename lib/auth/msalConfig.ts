import type { Configuration, RedirectRequest } from '@azure/msal-browser';

const clientId = process.env.NEXT_PUBLIC_AZURE_CLIENT_ID || '';
const tenantId = process.env.NEXT_PUBLIC_AZURE_TENANT_ID || 'common';

export const msalConfig: Configuration = {
  auth: {
    clientId,
    authority: `https://login.microsoftonline.com/${tenantId}`,
    redirectUri: typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3000'
  },
  cache: {
    // Per-tab auth state. Each tab can be a different signed-in user
    // (e.g. Alice in tab 1, Bob in tab 2) within the same browser profile.
    // Refresh keeps the session; closing the tab clears it.
    cacheLocation: 'sessionStorage',
    storeAuthStateInCookie: false
  }
};

/**
 * OAuth scopes requested for every signed-in session.
 *
 * Read scopes — needed by every user:
 *   User.Read              identity (oid, name, upn) for chat auth
 *   GroupMember.Read.All   transitiveMemberOf for ACL
 *
 * Write scopes — needed by admin-panel features (create/update/delete
 * users + groups, attach/detach members):
 *   User.ReadWrite.All     CRUD on users
 *   Group.ReadWrite.All    CRUD on groups + member ops
 *
 * Auth-methods scope — needed by the password-reset path:
 *   UserAuthenticationMethod.ReadWrite.All
 *     Microsoft has migrated admin password reset off the legacy
 *     passwordProfile PATCH and onto the new Authentication Methods
 *     API. Many tenants now reject the legacy path with 403 /
 *     accessDenied. The new endpoint
 *     `POST /users/{id}/authentication/methods/{passwordMethodId}/resetPassword`
 *     requires this scope.
 *
 * Why request the write scopes for EVERY user, not just admins:
 *   - Admin consent on these scopes (granted once per tenant in the app
 *     registration) means MSAL never prompts the user — the token
 *     simply carries them.
 *   - Graph still enforces Entra role on every write call. A regular
 *     user (alice / bob) holding these scopes can read the directory
 *     but Graph rejects any write because they lack the User
 *     Administrator role. So no privilege escalation — only admins who
 *     hold the role can actually do anything destructive.
 *   - Simpler than incremental consent (requesting elevated scopes only
 *     when the admin page loads). Same end-state security.
 *
 * Prerequisites in Azure portal:
 *   App registration → API permissions → add (Delegated):
 *     - User.ReadWrite.All
 *     - Group.ReadWrite.All
 *     - UserAuthenticationMethod.ReadWrite.All
 *   then click "Grant admin consent for <tenant>". Without admin
 *   consent, MSAL will fail silent token acquisition for every user
 *   and prompt for consent (which a non-admin can't grant).
 */
const SCOPES = [
  'User.Read',
  'GroupMember.Read.All',
  'User.ReadWrite.All',
  'Group.ReadWrite.All',
  'UserAuthenticationMethod.ReadWrite.All'
];

export const loginRequest: RedirectRequest = {
  scopes: SCOPES,
  // Force the Entra account picker so a second tab can sign in as a
  // different user even if Entra has a session cookie for the first one.
  prompt: 'select_account'
};

export const graphTokenRequest: RedirectRequest = {
  scopes: SCOPES
};
