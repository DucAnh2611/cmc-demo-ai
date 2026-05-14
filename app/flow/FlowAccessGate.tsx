'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { useIsAuthenticated, useMsal } from '@azure/msal-react';
import { graphTokenRequest, loginRequest } from '@/lib/auth/msalConfig';
import { FlowAccessEditor, type FlowAccessMode } from './FlowAccessEditor';

interface CheckResponse {
  decision: {
    granted: boolean;
    mode: FlowAccessMode;
    reason?: 'sign-in-required' | 'denied' | 'misconfigured' | 'invalid-link';
  };
  /** Admins receive the full policy including `linkToken` so the
   *  inline editor can show the shareable URL. Others see just the
   *  mode. */
  policy: { mode: FlowAccessMode; linkToken?: string };
  isAdmin: boolean;
}

/**
 * Client-side gate around the /flow doc.
 *
 * Renders the doc only when /api/flow-access/check returns granted.
 * Otherwise shows a friendly sign-in / denied state. Admins always see
 * the doc PLUS an "⚙ Manage access" affordance that opens the
 * `FlowAccessEditor` inline so the policy can be changed without
 * leaving the page.
 *
 * State machine:
 *   loading → check ----┬→ granted   : render children
 *                       ├→ sign-in   : prompt + login button
 *                       ├→ denied    : "you don't have permission"
 *                       └→ error     : show error, no children
 */
export default function FlowAccessGate({ children }: { children: React.ReactNode }) {
  const { instance, accounts } = useMsal();
  const isAuthenticated = useIsAuthenticated();
  const account = accounts[0];

  const [state, setState] = useState<CheckResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showEditor, setShowEditor] = useState(false);
  const [refetchKey, setRefetchKey] = useState(0);

  const acquireToken = useCallback(async (): Promise<string> => {
    if (!account) throw new Error('No active account');
    try {
      const r = await instance.acquireTokenSilent({ ...graphTokenRequest, account });
      return r.accessToken;
    } catch {
      const r = await instance.acquireTokenPopup({ ...graphTokenRequest, account });
      return r.accessToken;
    }
  }, [instance, account]);

  // Run the access check on mount + after each policy save / sign-in.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        let headers: Record<string, string> = {};
        // Try to attach a bearer token if there's an active account.
        // Failures (silent token acquisition + no popup possible mid-
        // load) fall through to an unauthenticated check — the server
        // returns sign-in-required for non-public modes.
        if (account) {
          try {
            const token = await instance
              .acquireTokenSilent({ ...graphTokenRequest, account })
              .then((r) => r.accessToken);
            headers = { Authorization: `Bearer ${token}` };
          } catch {
            /* unauthenticated path */
          }
        }
        // Forward the `?t=<token>` query param so the server can
        // validate the share link for `anyone-with-link` mode.
        const t = typeof window !== 'undefined' ? new URL(window.location.href).searchParams.get('t') : null;
        const qs = t ? `?t=${encodeURIComponent(t)}` : '';
        const res = await fetch(`/api/flow-access/check${qs}`, { headers });
        if (cancelled) return;
        if (!res.ok) {
          setError(`${res.status} ${(await res.text()).slice(0, 200)}`);
          return;
        }
        const data = (await res.json()) as CheckResponse;
        setState(data);
        setError(null);
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [account, instance, isAuthenticated, refetchKey]);

  if (loading) {
    return (
      <Centered>
        <p className="text-sm text-slate-500">Checking access…</p>
      </Centered>
    );
  }

  if (error) {
    return (
      <Centered>
        <h2 className="text-base font-semibold text-slate-900">Something went wrong</h2>
        <p className="mt-2 text-sm text-slate-600">{error}</p>
        <Link href="/" className="mt-4 inline-block text-sm text-slate-500 underline">
          ← Back to chat
        </Link>
      </Centered>
    );
  }

  if (!state) return null;

  if (!state.decision.granted) {
    if (state.decision.reason === 'sign-in-required') {
      return (
        <Centered>
          <h2 className="text-base font-semibold text-slate-900">Sign in to view this document</h2>
          <p className="mt-2 text-sm text-slate-600">
            The administrator restricted /flow to signed-in users. Sign in to continue.
          </p>
          <button
            type="button"
            onClick={() => instance.loginPopup(loginRequest).catch(() => {})}
            className="mt-4 rounded-md bg-slate-900 px-4 py-1.5 text-sm font-medium text-white hover:bg-slate-800"
          >
            Sign in
          </button>
          <Link href="/" className="ml-3 text-sm text-slate-500 underline">
            ← Back
          </Link>
        </Centered>
      );
    }
    // invalid-link, denied, or misconfigured
    let heading = 'You don’t have permission to view this document';
    let message =
      'Ask an administrator to add your account or one of your groups to the allowlist.';
    if (state.decision.reason === 'misconfigured') {
      heading = 'Access not configured';
      message =
        '/flow is in Restricted mode but no groups or people have been added yet. Ask an administrator to update access.';
    } else if (state.decision.reason === 'invalid-link') {
      heading = 'Share link missing or invalid';
      message =
        'This document is in "anyone with link" mode. Access requires the share URL the administrator generated — ask them for the link or use the original URL they sent you.';
    }
    return (
      <Centered>
        <h2 className="text-base font-semibold text-slate-900">{heading}</h2>
        <p className="mt-2 text-sm text-slate-600">{message}</p>
        <Link href="/" className="mt-4 inline-block text-sm text-slate-500 underline">
          ← Back to chat
        </Link>
      </Centered>
    );
  }

  // Granted — render the doc, plus the admin inline editor affordance.
  return (
    <>
      {state.isAdmin && (
        <div className="fixed bottom-4 right-4 z-40">
          {showEditor ? (
            <div className="w-[28rem] max-w-[calc(100vw-2rem)] rounded-xl border border-slate-200 bg-white p-4 shadow-2xl">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h3 className="text-sm font-semibold text-slate-900">Manage /flow access</h3>
                  <p className="mt-0.5 text-[11px] text-slate-500">
                    Current mode:{' '}
                    <strong>{state.policy.mode}</strong>. Visible to admins only.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setShowEditor(false)}
                  className="rounded-md px-1.5 py-0.5 text-sm text-slate-500 hover:bg-slate-100"
                  aria-label="Close"
                >
                  ✕
                </button>
              </div>
              <div className="mt-3 max-h-[70vh] overflow-y-auto pr-1">
                <FlowAccessEditor
                  acquireToken={acquireToken}
                  onSaved={() => setRefetchKey((k) => k + 1)}
                />
              </div>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setShowEditor(true)}
              className="rounded-full bg-slate-900 px-4 py-2 text-xs font-medium text-white shadow-lg hover:bg-slate-800"
              title="Manage who can read /flow"
            >
              ⚙ Manage access
            </button>
          )}
        </div>
      )}
      {children}
    </>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <main className="min-h-screen bg-slate-50 px-6 py-10">
      <div className="mx-auto max-w-md rounded-xl border border-slate-200 bg-white p-6 text-center shadow-sm">
        {children}
      </div>
    </main>
  );
}
