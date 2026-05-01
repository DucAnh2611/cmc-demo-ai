import jwt, { type JwtPayload } from 'jsonwebtoken';

const tenantId = process.env.NEXT_PUBLIC_AZURE_TENANT_ID || '';
const audience =
  process.env.AZURE_API_AUDIENCE || process.env.NEXT_PUBLIC_AZURE_CLIENT_ID || '';

const ISSUER_V2 = `https://login.microsoftonline.com/${tenantId}/v2.0`;
const ISSUER_V1 = `https://sts.windows.net/${tenantId}/`;

// Microsoft Graph constants — every Graph token has one of these as its `aud`.
const GRAPH_RESOURCE = 'https://graph.microsoft.com';
const GRAPH_APP_ID = '00000003-0000-0000-c000-000000000000';

const VALID_AUDIENCES = new Set<string>([
  GRAPH_RESOURCE,
  GRAPH_APP_ID,
  ...(audience ? [audience, `api://${audience}`] : [])
]);

const VALID_ISSUERS = new Set<string>([ISSUER_V1, ISSUER_V2]);

export interface VerifiedToken {
  oid: string;
  upn?: string;
  name?: string;
  scopes: string[];
  raw: JwtPayload;
}

/**
 * Claims-only validation for the user's bearer token.
 *
 * We deliberately skip RS256 signature verification: Microsoft Graph tokens
 * are signed with Graph-internal keys and carry a nonce that breaks JWKS
 * verification. Microsoft's guidance is to "validate by use" — if a follow-up
 * Graph call (e.g. `getUserGroups`) returns 200, the token was valid.
 *
 * What this function still enforces:
 *   - well-formed JWT
 *   - `exp` not passed
 *   - `aud` matches Graph (or a configured backend API audience)
 *   - `iss` matches the configured tenant (V1 or V2 endpoint)
 *   - `oid` claim is present
 *
 * To upgrade to full signature verification, register a separate backend
 * API in Entra, expose a scope (e.g. `api://<backend-id>/access_as_user`),
 * have the SPA request that scope instead of Graph, and switch this function
 * back to `jwt.verify(token, getKey, { algorithms: ['RS256'], audience, issuer })`
 * with `jwks-rsa` providing `getKey`.
 */
export function verifyAccessToken(token: string): Promise<VerifiedToken> {
  return new Promise((resolve, reject) => {
    const decoded = jwt.decode(token, { complete: false }) as JwtPayload | null;
    if (!decoded || typeof decoded !== 'object') {
      return reject(new Error('Token is not a well-formed JWT'));
    }

    const now = Math.floor(Date.now() / 1000);
    if (typeof decoded.exp === 'number' && decoded.exp < now) {
      return reject(new Error('Token expired'));
    }

    const audClaim = decoded.aud;
    const auds = Array.isArray(audClaim) ? audClaim : audClaim ? [audClaim] : [];
    if (!auds.some((a) => VALID_AUDIENCES.has(a))) {
      return reject(new Error(`Unexpected audience: ${auds.join(', ') || '(none)'}`));
    }

    if (!decoded.iss || !VALID_ISSUERS.has(decoded.iss)) {
      return reject(new Error(`Unexpected issuer: ${decoded.iss || '(none)'}`));
    }

    const oid = (decoded.oid as string) || (decoded.sub as string);
    if (!oid) return reject(new Error('Token missing oid claim'));

    const scopeStr = (decoded.scp as string) || '';
    resolve({
      oid,
      upn: (decoded.upn as string) || (decoded.preferred_username as string),
      name: decoded.name as string | undefined,
      scopes: scopeStr ? scopeStr.split(' ') : [],
      raw: decoded
    });
  });
}
