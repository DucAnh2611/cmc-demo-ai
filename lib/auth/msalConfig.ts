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

export const loginRequest: RedirectRequest = {
  scopes: ['User.Read', 'GroupMember.Read.All'],
  // Force the Entra account picker so a second tab can sign in as a
  // different user even if Entra has a session cookie for the first one.
  prompt: 'select_account'
};

export const graphTokenRequest: RedirectRequest = {
  scopes: ['User.Read', 'GroupMember.Read.All']
};
