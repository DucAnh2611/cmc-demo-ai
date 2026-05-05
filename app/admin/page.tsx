'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useMsal, useIsAuthenticated } from '@azure/msal-react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { graphTokenRequest } from '@/lib/auth/msalConfig';

// =====================================================================
// Types — mirror the Graph shapes returned by /api/admin/* endpoints
// =====================================================================

interface AdminUser {
  id: string;
  displayName: string;
  userPrincipalName: string;
  mail?: string | null;
  jobTitle?: string | null;
  accountEnabled?: boolean;
  /** Server-set on the detail response: this user is in
   *  GROUP_APP_ADMINS_ID, so the panel must NOT offer Delete. The
   *  DELETE handler also enforces this; the flag is purely UX. */
  isAppAdmin?: boolean;
  /** Server-set: target's UPN contains `#EXT#` — i.e. tenant owner or
   *  B2B guest. These accounts are also undeletable from the panel
   *  (DELETE handler enforces). */
  isSystemAccount?: boolean;
}

interface AdminGroup {
  id: string;
  displayName: string;
  description?: string | null;
  securityEnabled?: boolean;
  mailEnabled?: boolean;
  groupTypes?: string[];
  /** Server flag: this group is the in-app admin group (matches
   *  GROUP_APP_ADMINS_ID). Membership cannot be modified from the
   *  panel — see the POST /api/admin/groups/{id}/members guard. */
  isAppAdminGroup?: boolean;
  /** Server flag: this group is the uploaders group (matches
   *  GROUP_UPLOADERS_ID). Currently informational only. */
  isUploadersGroup?: boolean;
}

type AdminTab = 'users' | 'groups';

// =====================================================================
// Page shell
// =====================================================================

export default function AdminPage() {
  const { instance, accounts } = useMsal();
  const isAuthenticated = useIsAuthenticated();
  const router = useRouter();
  const [tab, setTab] = useState<AdminTab>('users');

  useEffect(() => {
    if (!isAuthenticated) router.replace('/login');
  }, [isAuthenticated, router]);

  const account = accounts[0];

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

  if (!isAuthenticated || !account) return null;

  const upn = account.username || '';
  const displayName = upn.split('@')[0] || upn;

  return (
    <main className="min-h-screen bg-slate-50">
      <header className="border-b bg-white px-6 py-3">
        <div className="mx-auto flex max-w-6xl items-center justify-between">
          <div className="flex items-center gap-3">
            <Link
              href="/"
              className="text-sm text-slate-500 underline hover:text-slate-900"
            >
              ← Chat
            </Link>
            <h1 className="text-base font-semibold text-slate-900">Admin · Users &amp; Groups</h1>
          </div>
          <div className="text-xs text-slate-500" title={upn}>
            Signed in as <span className="font-medium text-slate-700">{displayName}</span>
          </div>
        </div>
        {/* Tabs */}
        <div className="mx-auto mt-3 flex max-w-6xl gap-1 rounded-md bg-slate-100 p-1 text-sm">
          <TabButton active={tab === 'users'} onClick={() => setTab('users')}>
            Users
          </TabButton>
          <TabButton active={tab === 'groups'} onClick={() => setTab('groups')}>
            Groups
          </TabButton>
        </div>
      </header>

      <div className="mx-auto max-w-6xl px-6 py-6">
        {tab === 'users' && <UsersTab acquireToken={acquireToken} />}
        {tab === 'groups' && <GroupsTab acquireToken={acquireToken} />}
      </div>
    </main>
  );
}

function TabButton({
  active,
  onClick,
  children
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex-1 rounded px-3 py-1.5 font-medium transition ${
        active ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600 hover:text-slate-900'
      }`}
    >
      {children}
    </button>
  );
}

// =====================================================================
// Tenant ID helper for portal deep-links
// =====================================================================
//
// The Azure portal user-detail blade is keyed on userId (not UPN). We
// embed the URL right next to "Open in Azure ↗" so admins can jump
// straight to the deeper screens we don't reimplement.

function userPortalUrl(id: string): string {
  // %2F-encoded so Azure resolves the route correctly inside the SPA.
  return `https://portal.azure.com/#view/Microsoft_AAD_UsersAndTenants/UserProfileMenuBlade/~/overview/userId/${encodeURIComponent(id)}`;
}

function groupPortalUrl(id: string): string {
  return `https://portal.azure.com/#view/Microsoft_AAD_IAM/GroupDetailsMenuBlade/~/Overview/groupId/${encodeURIComponent(id)}`;
}

// =====================================================================
// Password generator — 16 chars, guaranteed mix of upper/lower/digit/sym
// Picks confusing characters out (no I/O/l/0/1) so a non-tech admin can
// dictate the password over the phone if needed. Uses Math.random which
// is fine for an initial password the user will rotate on first login.
// =====================================================================

function generatePassword(): string {
  const UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const LOWER = 'abcdefghijkmnpqrstuvwxyz';
  const DIGIT = '23456789';
  const SYM = '!@#$%^&*-_=+';
  const ALL = UPPER + LOWER + DIGIT + SYM;
  const pick = (s: string) => s[Math.floor(Math.random() * s.length)];
  const out = [pick(UPPER), pick(LOWER), pick(DIGIT), pick(SYM)];
  while (out.length < 16) out.push(pick(ALL));
  // Fisher-Yates shuffle so the required-set chars aren't always at front
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out.join('');
}

// =====================================================================
// Generic two-step delete confirmation
// =====================================================================
//
// Pattern: first click flips into "type the name to confirm" mode, the
// destructive button is disabled until the typed value matches the
// expected name. Same idea as GitHub's repo-delete confirm. Two-step
// stops a stray double-click from nuking a user/group.

function ConfirmDelete({
  expectedName,
  busy,
  onConfirm,
  onCancel,
  label
}: {
  expectedName: string;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  label: string;
}) {
  const [typed, setTyped] = useState('');
  const matches = typed.trim() === expectedName;
  return (
    <div className="mt-3 rounded-md border border-red-300 bg-red-50 p-3 text-xs">
      <div className="font-semibold text-red-900">Permanently delete this {label}?</div>
      <div className="mt-1 text-red-800">
        Type <code className="rounded bg-white px-1 font-mono">{expectedName}</code> to confirm.
        Microsoft Graph soft-deletes, so it&rsquo;s recoverable for 30 days from the Azure
        portal Deleted Users/Groups blade — but this app no longer sees it.
      </div>
      <input
        type="text"
        value={typed}
        onChange={(e) => setTyped(e.target.value)}
        autoFocus
        className="mt-2 block w-full rounded border border-red-300 bg-white px-2 py-1 font-mono text-xs focus:border-red-500 focus:outline-none"
      />
      <div className="mt-2 flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          className="rounded px-2 py-1 text-slate-600 hover:bg-slate-100 disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={onConfirm}
          disabled={busy || !matches}
          className="rounded bg-red-600 px-3 py-1 font-semibold text-white hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? 'Deleting…' : `Delete ${label}`}
        </button>
      </div>
    </div>
  );
}

// =====================================================================
// Reset-password inline panel
// =====================================================================
//
// Sits in the user-detail action area when the admin clicks "Reset
// password". Two-state: BEFORE (show new password + Confirm/Cancel),
// AFTER (show success + same password value visible for the admin to
// copy and share). We DON'T auto-close after success — the admin needs
// time to copy or screenshot the new password.

function ResetPasswordPanel({
  userId,
  userPrincipalName,
  acquireToken,
  onClose
}: {
  userId: string;
  userPrincipalName: string;
  acquireToken: () => Promise<string>;
  onClose: () => void;
}) {
  const [password, setPassword] = useState(generatePassword);
  const [forceChange, setForceChange] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [copied, setCopied] = useState(false);

  const copyPw = async () => {
    try {
      await navigator.clipboard.writeText(password);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked — value is still selectable in the input */
    }
  };

  const handleReset = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const token = await acquireToken();
      const res = await fetch(`/api/admin/users/${encodeURIComponent(userId)}/password`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ password, forceChangePasswordNextSignIn: forceChange })
      });
      if (!res.ok) {
        setError(`${res.status} ${(await res.text()).slice(0, 300)}`);
        return;
      }
      setDone(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-3 rounded-md border border-amber-300 bg-amber-50 p-3 text-xs">
      <div className="flex items-start justify-between gap-2">
        <div className="font-semibold text-amber-900">
          {done ? 'Password reset · share the new password' : 'Reset password for this user'}
        </div>
        {done && (
          <button
            type="button"
            onClick={onClose}
            className="rounded px-2 py-0.5 text-amber-700 hover:bg-white"
            aria-label="Close"
          >
            ✕
          </button>
        )}
      </div>

      {!done && (
        <p className="mt-1 text-amber-800">
          A new auto-generated password will replace{' '}
          <code className="rounded bg-white px-1 font-mono">{userPrincipalName}</code>
          &apos;s current one. The user is forced to change it on next sign-in (unless
          you uncheck below).
        </p>
      )}
      {done && (
        <p className="mt-1 text-amber-800">
          The password below is the user&rsquo;s NEW one. Share it securely with{' '}
          <code className="rounded bg-white px-1 font-mono">{userPrincipalName}</code>{' '}
          before closing this panel — the password isn&rsquo;t stored anywhere on the server.
        </p>
      )}

      <div className="mt-2 flex gap-2">
        <input
          type="text"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          readOnly={done}
          className={`block w-full rounded border px-2 py-1 font-mono text-xs focus:outline-none ${
            done
              ? 'border-amber-200 bg-white text-amber-900'
              : 'border-amber-300 bg-white focus:border-amber-500'
          }`}
        />
        {!done && (
          <button
            type="button"
            onClick={() => setPassword(generatePassword())}
            disabled={busy}
            className="shrink-0 rounded border border-amber-300 bg-white px-2 text-amber-800 hover:bg-amber-100 disabled:opacity-50"
            title="Regenerate"
          >
            ↻
          </button>
        )}
        <button
          type="button"
          onClick={copyPw}
          className={`shrink-0 rounded border px-2 font-medium ${
            copied
              ? 'border-emerald-300 bg-emerald-50 text-emerald-700'
              : 'border-amber-300 bg-white text-amber-800 hover:bg-amber-100'
          }`}
        >
          {copied ? '✓ Copied' : 'Copy'}
        </button>
      </div>

      {!done && (
        <label className="mt-2 flex items-center gap-2 text-amber-900">
          <input
            type="checkbox"
            checked={forceChange}
            onChange={(e) => setForceChange(e.target.checked)}
            className="h-3.5 w-3.5"
          />
          Force user to change password on next sign-in
        </label>
      )}

      {error && (
        <div className="mt-2 rounded-md border border-red-200 bg-red-50 p-2 text-red-800">
          {error}
        </div>
      )}

      {!done && (
        <div className="mt-2 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded px-2 py-1 text-amber-800 hover:bg-white disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleReset}
            disabled={busy || password.length < 8}
            className="rounded bg-amber-600 px-3 py-1 font-semibold text-white hover:bg-amber-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy ? 'Resetting…' : 'Reset password'}
          </button>
        </div>
      )}
      {done && (
        <div className="mt-2 flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="rounded bg-amber-600 px-3 py-1 font-semibold text-white hover:bg-amber-700"
          >
            Done
          </button>
        </div>
      )}
    </div>
  );
}

// =====================================================================
// Modal shell — used by both Create User and Create Group forms
// =====================================================================

function Modal({
  title,
  onClose,
  children
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        className="flex max-h-[95dvh] w-full max-w-lg flex-col overflow-hidden rounded-xl bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="shrink-0 flex items-center justify-between border-b px-5 py-3">
          <h3 className="text-base font-semibold text-slate-900">{title}</h3>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-2 py-1 text-sm text-slate-500 hover:bg-slate-100"
          >
            ✕
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-4">{children}</div>
      </div>
    </div>
  );
}

// =====================================================================
// Shared error / empty states
// =====================================================================

function ErrorBanner({ message }: { message: string }) {
  return (
    <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">
      <div className="font-medium">Couldn&rsquo;t load this</div>
      <div className="mt-1 text-xs">{message}</div>
      {/^.*403/.test(message) && (
        <div className="mt-2 text-xs text-red-700">
          <strong>Common causes:</strong>
          <ul className="mt-1 list-disc pl-5">
            <li>
              Your account isn&rsquo;t in the group named in <code>GROUP_APP_ADMINS_ID</code>.
            </li>
            <li>
              The app registration is missing <code>User.ReadWrite.All</code> /{' '}
              <code>Group.ReadWrite.All</code>, or admin consent wasn&rsquo;t granted.
            </li>
            <li>
              Your account doesn&rsquo;t hold an Entra role like{' '}
              <em>User Administrator</em>. Graph rejects writes regardless of the OAuth scope
              when the role is missing.
            </li>
          </ul>
        </div>
      )}
    </div>
  );
}

// =====================================================================
// Users tab
// =====================================================================

function UsersTab({ acquireToken }: { acquireToken: () => Promise<string> }) {
  const [users, setUsers] = useState<AdminUser[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Bumping refetchKey re-runs the list fetch — used after create / edit
  // / delete. Cheaper than refactoring the whole tab to a query lib.
  const [refetchKey, setRefetchKey] = useState(0);
  const [showCreate, setShowCreate] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const token = await acquireToken();
        const res = await fetch('/api/admin/users', {
          headers: { Authorization: `Bearer ${token}` }
        });
        if (cancelled) return;
        if (!res.ok) {
          setError(`${res.status} ${(await res.text()).slice(0, 300)}`);
        } else {
          const data = (await res.json()) as { users: AdminUser[] };
          setUsers(data.users);
          setError(null);
        }
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [acquireToken, refetchKey]);

  const filtered = useMemo(() => {
    if (!users) return [];
    const q = filter.trim().toLowerCase();
    if (!q) return users;
    return users.filter(
      (u) =>
        u.displayName.toLowerCase().includes(q) ||
        u.userPrincipalName.toLowerCase().includes(q) ||
        (u.mail || '').toLowerCase().includes(q)
    );
  }, [users, filter]);

  return (
    <div className="grid grid-cols-1 gap-6 md:grid-cols-[1fr_24rem]">
      <section>
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-lg font-semibold text-slate-900">Users</h2>
          <div className="flex items-center gap-3">
            <span className="text-xs text-slate-500">
              {users ? `${filtered.length} of ${users.length}` : ''}
            </span>
            <button
              type="button"
              onClick={() => setRefetchKey((k) => k + 1)}
              disabled={loading}
              className="rounded-md border border-slate-300 px-2 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-50"
              title="Re-fetch from Microsoft Graph"
              aria-label="Refresh users list"
            >
              {loading ? '…' : '↻'}
            </button>
            <button
              type="button"
              onClick={() => setShowCreate(true)}
              className="rounded-md bg-slate-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-800"
            >
              + New user
            </button>
          </div>
        </div>
        <input
          type="text"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Search by name, UPN, or email…"
          className="mt-2 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-500 focus:outline-none"
        />

        {showCreate && (
          <CreateUserModal
            acquireToken={acquireToken}
            onClose={() => setShowCreate(false)}
            onCreated={(id) => {
              setShowCreate(false);
              setSelectedId(id);
              setRefetchKey((k) => k + 1);
            }}
          />
        )}

        {loading && <div className="mt-3 text-sm text-slate-500">Loading users…</div>}
        {error && (
          <div className="mt-3">
            <ErrorBanner message={error} />
          </div>
        )}
        {users && filtered.length === 0 && !loading && (
          <div className="mt-3 rounded-md border border-slate-200 bg-white p-4 text-sm text-slate-600">
            No users match the search.
          </div>
        )}

        {filtered.length > 0 && (
          <ul className="mt-3 divide-y divide-slate-100 rounded-lg border border-slate-200 bg-white">
            {filtered.map((u) => (
              <li key={u.id}>
                <button
                  type="button"
                  onClick={() => setSelectedId(u.id)}
                  className={`block w-full px-4 py-3 text-left text-sm hover:bg-slate-50 ${
                    selectedId === u.id ? 'bg-slate-50' : ''
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium text-slate-900">{u.displayName}</span>
                    <span className="flex items-center gap-1">
                      {u.isAppAdmin && (
                        <span
                          className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-slate-600"
                          title="App-admins group member — view-only here"
                        >
                          Admin · view only
                        </span>
                      )}
                      {!u.isAppAdmin && u.isSystemAccount && (
                        <span
                          className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-slate-600"
                          title="System / external account (#EXT#) — view-only here"
                        >
                          System · view only
                        </span>
                      )}
                      {u.accountEnabled === false && (
                        <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-800">
                          Disabled
                        </span>
                      )}
                    </span>
                  </div>
                  <div className="mt-0.5 text-xs text-slate-500">{u.userPrincipalName}</div>
                  {u.jobTitle && (
                    <div className="mt-0.5 text-[11px] text-slate-400">{u.jobTitle}</div>
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <aside className="md:sticky md:top-6 md:self-start">
        {selectedId ? (
          <UserDetail
            id={selectedId}
            acquireToken={acquireToken}
            onClose={() => setSelectedId(null)}
            onChanged={() => setRefetchKey((k) => k + 1)}
            onDeleted={() => {
              setSelectedId(null);
              setRefetchKey((k) => k + 1);
            }}
          />
        ) : (
          <div className="rounded-lg border border-slate-200 bg-white p-6 text-sm text-slate-500">
            Pick a user on the left to see their details + group memberships.
          </div>
        )}
      </aside>
    </div>
  );
}

function UserDetail({
  id,
  acquireToken,
  onClose,
  onChanged,
  onDeleted
}: {
  id: string;
  acquireToken: () => Promise<string>;
  onClose: () => void;
  onChanged: () => void;
  onDeleted: () => void;
}) {
  const [data, setData] = useState<{ user: AdminUser; groups: AdminGroup[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [refetch, setRefetch] = useState(0);
  const [showAddToGroup, setShowAddToGroup] = useState(false);
  const [showResetPassword, setShowResetPassword] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setData(null);
    setEditing(false);
    setConfirmingDelete(false);
    setShowAddToGroup(false);
    setShowResetPassword(false);
    (async () => {
      try {
        const token = await acquireToken();
        const res = await fetch(`/api/admin/users/${encodeURIComponent(id)}`, {
          headers: { Authorization: `Bearer ${token}` }
        });
        if (cancelled) return;
        if (!res.ok) {
          setError(`${res.status} ${(await res.text()).slice(0, 300)}`);
        } else {
          setData((await res.json()) as { user: AdminUser; groups: AdminGroup[] });
        }
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id, acquireToken, refetch]);

  const handleDelete = async () => {
    if (busy) return;
    setBusy(true);
    setActionError(null);
    try {
      const token = await acquireToken();
      const res = await fetch(`/api/admin/users/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` }
      });
      if (!res.ok) {
        setActionError(`${res.status} ${(await res.text()).slice(0, 300)}`);
        return;
      }
      onDeleted();
    } catch (e) {
      setActionError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const handleSave = async (patch: { displayName?: string; jobTitle?: string; accountEnabled?: boolean }) => {
    if (busy) return;
    setBusy(true);
    setActionError(null);
    try {
      const token = await acquireToken();
      const res = await fetch(`/api/admin/users/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(patch)
      });
      if (!res.ok) {
        setActionError(`${res.status} ${(await res.text()).slice(0, 300)}`);
        return;
      }
      setEditing(false);
      setRefetch((n) => n + 1);
      onChanged();
    } catch (e) {
      setActionError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // Group membership management on the USER side. Both endpoints live
  // under /api/admin/groups/{gid}/members — same routes used by
  // GroupDetail. We pass the user.id as the body / query param.
  const handleAddToGroup = async (groupId: string) => {
    if (busy || !data) return;
    setBusy(true);
    setActionError(null);
    try {
      const token = await acquireToken();
      const res = await fetch(`/api/admin/groups/${encodeURIComponent(groupId)}/members`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: data.user.id })
      });
      if (!res.ok) {
        setActionError(`${res.status} ${(await res.text()).slice(0, 300)}`);
        return;
      }
      setShowAddToGroup(false);
      setRefetch((n) => n + 1);
      // Bubble up so the parent tab's list also re-fetches. Keeps the
      // group-count column (and any future per-row metadata that depends
      // on membership) in sync without the admin having to click around.
      onChanged();
    } catch (e) {
      setActionError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const handleRemoveFromGroup = async (groupId: string) => {
    if (busy || !data) return;
    setBusy(true);
    setActionError(null);
    try {
      const token = await acquireToken();
      const res = await fetch(
        `/api/admin/groups/${encodeURIComponent(groupId)}/members?userId=${encodeURIComponent(data.user.id)}`,
        { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } }
      );
      if (!res.ok) {
        setActionError(`${res.status} ${(await res.text()).slice(0, 300)}`);
        return;
      }
      setRefetch((n) => n + 1);
      onChanged();
    } catch (e) {
      setActionError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-5">
      <div className="flex items-start justify-between gap-3">
        <h3 className="text-base font-semibold text-slate-900">User detail</h3>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setRefetch((n) => n + 1)}
            disabled={loading || busy}
            className="rounded-md px-2 py-1 text-sm text-slate-500 hover:bg-slate-100 disabled:opacity-50"
            title="Re-fetch from Microsoft Graph"
            aria-label="Refresh user detail"
          >
            {loading ? '…' : '↻'}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-2 py-1 text-sm text-slate-500 hover:bg-slate-100"
            aria-label="Close detail"
          >
            ✕
          </button>
        </div>
      </div>
      {loading && <div className="mt-3 text-sm text-slate-500">Loading…</div>}
      {error && (
        <div className="mt-3">
          <ErrorBanner message={error} />
        </div>
      )}
      {data && !editing && (
        <>
          <dl className="mt-3 space-y-2 text-sm">
            <KV k="Display name" v={data.user.displayName} />
            <KV k="UPN" v={data.user.userPrincipalName} />
            {data.user.mail && <KV k="Email" v={data.user.mail} />}
            {data.user.jobTitle && <KV k="Job title" v={data.user.jobTitle} />}
            <KV
              k="Account"
              v={
                <span
                  className={
                    data.user.accountEnabled === false ? 'text-amber-700' : 'text-emerald-700'
                  }
                >
                  {data.user.accountEnabled === false ? 'Disabled' : 'Enabled'}
                </span>
              }
            />
            <KV k="Object ID" v={<code className="text-xs">{data.user.id}</code>} />
          </dl>

          <div className="mt-4">
            <div className="flex items-center justify-between">
              <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                Member of {data.groups.length} group{data.groups.length === 1 ? '' : 's'}
              </div>
              {/* + Add to group hidden on protected users — same view-only
                  rule that hides Edit / Reset / Delete; backend rejects too. */}
              {!data.user.isAppAdmin && !data.user.isSystemAccount && (
                <button
                  type="button"
                  onClick={() => setShowAddToGroup((v) => !v)}
                  disabled={busy}
                  className="rounded-md border border-slate-300 px-2 py-0.5 text-[11px] font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-50"
                >
                  {showAddToGroup ? 'Cancel' : '+ Add to group'}
                </button>
              )}
            </div>

            {showAddToGroup && !data.user.isAppAdmin && !data.user.isSystemAccount && (
              <AddToGroupPicker
                acquireToken={acquireToken}
                excludeIds={new Set(data.groups.map((g) => g.id))}
                busy={busy}
                onPick={handleAddToGroup}
              />
            )}

            {data.groups.length === 0 ? (
              <div className="mt-1 text-xs text-slate-400">
                Not a member of any security group.
              </div>
            ) : (
              <ul className="mt-2 space-y-1 text-xs">
                {data.groups.map((g) => (
                  <li
                    key={g.id}
                    className="flex items-center justify-between gap-2 rounded border border-slate-200 bg-slate-50 px-2 py-1"
                  >
                    <div className="min-w-0">
                      <span className="font-medium text-slate-900">{g.displayName}</span>
                      {g.description && (
                        <span className="ml-1 text-slate-500">— {g.description}</span>
                      )}
                    </div>
                    {/* × Remove hidden on protected users — view-only. */}
                    {!data.user.isAppAdmin && !data.user.isSystemAccount && (
                      <button
                        type="button"
                        onClick={() => handleRemoveFromGroup(g.id)}
                        disabled={busy}
                        className="shrink-0 rounded p-1 text-red-500 hover:bg-red-50 hover:text-red-700 disabled:opacity-50"
                        title="Remove from group"
                        aria-label={`Remove from ${g.displayName}`}
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                          <path d="M3 6h18" />
                          <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                          <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                        </svg>
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>

          {actionError && (
            <div className="mt-3 rounded-md border border-red-200 bg-red-50 p-2 text-xs text-red-800">
              {actionError}
            </div>
          )}

          {confirmingDelete ? (
            <ConfirmDelete
              expectedName={data.user.userPrincipalName}
              busy={busy}
              onCancel={() => setConfirmingDelete(false)}
              onConfirm={handleDelete}
              label="user"
            />
          ) : showResetPassword ? (
            <ResetPasswordPanel
              userId={data.user.id}
              userPrincipalName={data.user.userPrincipalName}
              acquireToken={acquireToken}
              onClose={() => setShowResetPassword(false)}
            />
          ) : (
            <div className="mt-4 flex flex-wrap items-center gap-2">
              {/* All mutation controls (Edit / Reset password / Delete +
                  Add-to-group + ×-remove-from-group above) are hidden
                  when the target is protected:
                    - isAppAdmin     → admin churn is portal-only
                    - isSystemAccount → tenant owner / B2B guest (#EXT#);
                                       managing them here risks orphaning
                                       the tenant or breaking inbound sharing
                  Backend mutation handlers re-enforce both rules via
                  getUserProtection(). One pill explains the lockdown;
                  admin takes precedence over system when both apply. */}
              {!data.user.isAppAdmin && !data.user.isSystemAccount && (
                <>
                  <button
                    type="button"
                    onClick={() => setEditing(true)}
                    className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100"
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setShowResetPassword(true);
                      setActionError(null);
                    }}
                    className="rounded-md border border-amber-300 px-3 py-1.5 text-xs font-medium text-amber-800 hover:bg-amber-50"
                    title="Generate a new password for this user"
                  >
                    Reset password
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmingDelete(true)}
                    className="rounded-md border border-red-300 px-3 py-1.5 text-xs font-medium text-red-700 hover:bg-red-50"
                  >
                    Delete user
                  </button>
                </>
              )}
              {data.user.isAppAdmin && (
                <span
                  className="rounded-md border border-slate-200 bg-slate-50 px-2 py-1 text-[11px] text-slate-600"
                  title="App-admins group member — view-only here. Manage in Azure portal."
                >
                  View only · admin user — modify in Azure portal
                </span>
              )}
              {!data.user.isAppAdmin && data.user.isSystemAccount && (
                <span
                  className="rounded-md border border-slate-200 bg-slate-50 px-2 py-1 text-[11px] text-slate-600"
                  title="Tenant-owner or B2B guest (#EXT# UPN) — view-only here. Manage in Azure portal."
                >
                  View only · system account — modify in Azure portal
                </span>
              )}
              <a
                href={userPortalUrl(data.user.id)}
                target="_blank"
                rel="noreferrer"
                className="ml-auto rounded-md bg-slate-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-800"
              >
                Open in Azure portal ↗
              </a>
            </div>
          )}
        </>
      )}

      {data && editing && (
        <EditUserForm
          user={data.user}
          busy={busy}
          actionError={actionError}
          onCancel={() => {
            setEditing(false);
            setActionError(null);
          }}
          onSave={handleSave}
        />
      )}
    </div>
  );
}

function EditUserForm({
  user,
  busy,
  actionError,
  onCancel,
  onSave
}: {
  user: AdminUser;
  busy: boolean;
  actionError: string | null;
  onCancel: () => void;
  onSave: (patch: { displayName?: string; jobTitle?: string; accountEnabled?: boolean }) => void;
}) {
  const [displayName, setDisplayName] = useState(user.displayName);
  const [jobTitle, setJobTitle] = useState(user.jobTitle || '');
  const [accountEnabled, setAccountEnabled] = useState(user.accountEnabled !== false);

  return (
    <form
      className="mt-3 space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        // Only include changed fields — partial PATCH.
        const patch: { displayName?: string; jobTitle?: string; accountEnabled?: boolean } = {};
        if (displayName !== user.displayName) patch.displayName = displayName;
        if (jobTitle !== (user.jobTitle || '')) patch.jobTitle = jobTitle;
        if (accountEnabled !== (user.accountEnabled !== false)) patch.accountEnabled = accountEnabled;
        onSave(patch);
      }}
    >
      <FormField label="Display name">
        <input
          type="text"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          required
          className="block w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm focus:border-slate-500 focus:outline-none"
        />
      </FormField>
      <FormField label="Job title (optional)">
        <input
          type="text"
          value={jobTitle}
          onChange={(e) => setJobTitle(e.target.value)}
          className="block w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm focus:border-slate-500 focus:outline-none"
        />
      </FormField>
      <label className="flex items-center gap-2 text-sm text-slate-700">
        <input
          type="checkbox"
          checked={accountEnabled}
          onChange={(e) => setAccountEnabled(e.target.checked)}
          className="h-4 w-4"
        />
        Account enabled
      </label>
      {actionError && (
        <div className="rounded-md border border-red-200 bg-red-50 p-2 text-xs text-red-800">
          {actionError}
        </div>
      )}
      <div className="flex justify-end gap-2 pt-2">
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={busy}
          className="rounded-md bg-slate-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-800 disabled:opacity-50"
        >
          {busy ? 'Saving…' : 'Save'}
        </button>
      </div>
    </form>
  );
}

function FormField({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-xs font-semibold uppercase tracking-wide text-slate-600">
        {label}
      </label>
      {children}
      {hint && <p className="mt-0.5 text-[11px] text-slate-500">{hint}</p>}
    </div>
  );
}

function CreateUserModal({
  acquireToken,
  onClose,
  onCreated
}: {
  acquireToken: () => Promise<string>;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const [upn, setUpn] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState(generatePassword);
  const [forceChange, setForceChange] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  // Initial group picks — applied after the user is created.
  const [allGroups, setAllGroups] = useState<AdminGroup[] | null>(null);
  const [selectedGroupIds, setSelectedGroupIds] = useState<Set<string>>(new Set());
  const [partialErrors, setPartialErrors] = useState<string[]>([]);

  // Load groups in the background so the picker is ready by the time
  // the form is filled in. Failure is non-fatal — the section just
  // doesn't render and the user can still create + assign later.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const token = await acquireToken();
        const res = await fetch('/api/admin/groups', {
          headers: { Authorization: `Bearer ${token}` }
        });
        if (cancelled || !res.ok) return;
        const data = (await res.json()) as { groups: AdminGroup[] };
        setAllGroups(data.groups);
      } catch {
        /* ignore — groups picker just won't render */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [acquireToken]);

  const toggleGroup = (gid: string) => {
    setSelectedGroupIds((prev) => {
      const next = new Set(prev);
      if (next.has(gid)) next.delete(gid);
      else next.add(gid);
      return next;
    });
  };

  const copyPassword = async () => {
    try {
      await navigator.clipboard.writeText(password);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard might be blocked — user can still see + select the value */
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    setPartialErrors([]);
    try {
      const token = await acquireToken();
      const res = await fetch('/api/admin/users', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userPrincipalName: upn.trim(),
          displayName: displayName.trim(),
          password,
          forceChangePasswordNextSignIn: forceChange
        })
      });
      if (!res.ok) {
        setError(`${res.status} ${(await res.text()).slice(0, 400)}`);
        return;
      }
      const data = (await res.json()) as { user: { id: string } };
      const newId = data.user.id;

      // Apply group memberships sequentially. Sequential (not parallel)
      // because Graph occasionally rate-limits aggressive POSTs from the
      // same token. Per-group failures are collected and surfaced in
      // `partialErrors` — the user is still created, the admin can fix
      // the failed groups from the user-detail panel afterwards.
      const failures: string[] = [];
      for (const gid of selectedGroupIds) {
        try {
          const r = await fetch(`/api/admin/groups/${encodeURIComponent(gid)}/members`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId: newId })
          });
          if (!r.ok) {
            const groupName =
              allGroups?.find((g) => g.id === gid)?.displayName || gid.slice(0, 8);
            failures.push(`${groupName}: ${r.status} ${(await r.text()).slice(0, 100)}`);
          }
        } catch (err) {
          failures.push(`${gid.slice(0, 8)}: ${(err as Error).message}`);
        }
      }

      if (failures.length > 0) {
        // Show what failed but still close on user dismiss — user is
        // already created, the admin needs to know about the partial
        // success. We DON'T call onCreated yet so the modal stays open
        // and the failures are visible.
        setPartialErrors(failures);
        return;
      }
      onCreated(newId);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="Create user" onClose={onClose}>
      <form className="space-y-3" onSubmit={handleSubmit}>
        <FormField
          label="User principal name (UPN)"
          hint="The full sign-in name. Format: prefix@yourtenant.onmicrosoft.com"
        >
          <input
            type="email"
            value={upn}
            onChange={(e) => setUpn(e.target.value)}
            placeholder="alice@yourtenant.onmicrosoft.com"
            required
            autoFocus
            className="block w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm focus:border-slate-500 focus:outline-none"
          />
        </FormField>
        <FormField label="Display name" hint="What the chat UI will show.">
          <input
            type="text"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="Alice Nguyen"
            required
            className="block w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm focus:border-slate-500 focus:outline-none"
          />
        </FormField>
        <FormField
          label="Initial password"
          hint="Auto-generated · 16 chars · upper / lower / digit / symbol. The user must change it on first sign-in."
        >
          <div className="flex gap-2">
            <input
              type="text"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              className="block w-full rounded-md border border-slate-300 px-3 py-1.5 font-mono text-sm focus:border-slate-500 focus:outline-none"
            />
            <button
              type="button"
              onClick={() => setPassword(generatePassword())}
              className="shrink-0 rounded-md border border-slate-300 px-2 text-xs text-slate-700 hover:bg-slate-100"
              title="Regenerate"
            >
              ↻
            </button>
            <button
              type="button"
              onClick={copyPassword}
              className={`shrink-0 rounded-md border px-2 text-xs font-medium ${
                copied
                  ? 'border-emerald-300 bg-emerald-50 text-emerald-700'
                  : 'border-slate-300 text-slate-700 hover:bg-slate-100'
              }`}
            >
              {copied ? '✓ Copied' : 'Copy'}
            </button>
          </div>
        </FormField>
        <label className="flex items-center gap-2 text-sm text-slate-700">
          <input
            type="checkbox"
            checked={forceChange}
            onChange={(e) => setForceChange(e.target.checked)}
            className="h-4 w-4"
          />
          Force user to change password on first sign-in
        </label>

        {/* Initial group memberships — optional. Renders only after the
            background fetch returns groups. Each toggle is a controlled
            checkbox in selectedGroupIds; the form's submit handler
            iterates POST /members per pick after the user is created. */}
        {(() => {
          // Hide the in-app admin group from the picker — assignment to
          // it is blocked server-side anyway (POST /members guard), so
          // there's no point offering it. Same enforcement as the
          // AddToGroupPicker on UserDetail.
          const pickable = (allGroups || []).filter((g) => !g.isAppAdminGroup);
          return pickable.length > 0 && (
          <FormField
            label={`Add to groups (optional · ${selectedGroupIds.size} selected)`}
            hint="Group memberships are added right after the user is created. You can also manage these later from the user detail panel. Admin elevation isn't shown — that must happen in Azure portal."
          >
            <div className="max-h-40 space-y-1 overflow-y-auto rounded-md border border-slate-200 bg-slate-50 p-2">
              {pickable.map((g) => (
                <label
                  key={g.id}
                  className="flex items-start gap-2 rounded px-2 py-1 text-xs hover:bg-white"
                >
                  <input
                    type="checkbox"
                    checked={selectedGroupIds.has(g.id)}
                    onChange={() => toggleGroup(g.id)}
                    className="mt-0.5 h-3.5 w-3.5"
                  />
                  <span className="min-w-0">
                    <span className="font-medium text-slate-900">{g.displayName}</span>
                    {g.description && (
                      <span className="ml-1 text-slate-500">— {g.description}</span>
                    )}
                  </span>
                </label>
              ))}
            </div>
          </FormField>
          );
        })()}

        {error && (
          <div className="rounded-md border border-red-200 bg-red-50 p-2 text-xs text-red-800">
            {error}
          </div>
        )}

        {partialErrors.length > 0 && (
          <div className="rounded-md border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900">
            <div className="font-semibold">User created, but some groups failed:</div>
            <ul className="mt-1 list-disc pl-4">
              {partialErrors.map((m, i) => (
                <li key={i}>{m}</li>
              ))}
            </ul>
            <p className="mt-1">
              You can retry the failed groups from the user&rsquo;s detail panel after
              closing this dialog.
            </p>
          </div>
        )}
        <div className="flex items-center justify-between gap-2 border-t pt-3">
          <p className="text-[11px] text-slate-500 flex-1">
            After creating, share the password with the user securely (chat / 1Pass).
            They&rsquo;ll be prompted to set their own at first sign-in.
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={busy}
              className="rounded-md border border-slate-300 px-3 py-1.5 whitespace-nowrap text-sm text-slate-700 hover:bg-slate-100 disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={busy || !upn || !displayName || !password}
              className="rounded-md bg-slate-900 px-4 py-1.5 text-sm whitespace-nowrap font-medium text-white hover:bg-slate-800 disabled:opacity-50"
            >
              {busy ? 'Creating…' : 'Create user'}
            </button>
          </div>
        </div>
      </form>
    </Modal>
  );
}

function KV({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2">
      <dt className="w-28 shrink-0 text-xs font-semibold uppercase tracking-wide text-slate-500">
        {k}
      </dt>
      <dd className="flex-1 break-all text-slate-800">{v}</dd>
    </div>
  );
}

// =====================================================================
// Groups tab
// =====================================================================

function GroupsTab({ acquireToken }: { acquireToken: () => Promise<string> }) {
  const [groups, setGroups] = useState<AdminGroup[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [refetchKey, setRefetchKey] = useState(0);
  const [showCreate, setShowCreate] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const token = await acquireToken();
        const res = await fetch('/api/admin/groups', {
          headers: { Authorization: `Bearer ${token}` }
        });
        if (cancelled) return;
        if (!res.ok) {
          setError(`${res.status} ${(await res.text()).slice(0, 300)}`);
        } else {
          const data = (await res.json()) as { groups: AdminGroup[] };
          setGroups(data.groups);
          setError(null);
        }
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [acquireToken, refetchKey]);

  const filtered = useMemo(() => {
    if (!groups) return [];
    const q = filter.trim().toLowerCase();
    if (!q) return groups;
    return groups.filter(
      (g) =>
        g.displayName.toLowerCase().includes(q) ||
        (g.description || '').toLowerCase().includes(q)
    );
  }, [groups, filter]);

  return (
    <div className="grid grid-cols-1 gap-6 md:grid-cols-[1fr_24rem]">
      <section>
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-lg font-semibold text-slate-900">Security groups</h2>
          <div className="flex items-center gap-3">
            <span className="text-xs text-slate-500">
              {groups ? `${filtered.length} of ${groups.length}` : ''}
            </span>
            <button
              type="button"
              onClick={() => setRefetchKey((k) => k + 1)}
              disabled={loading}
              className="rounded-md border border-slate-300 px-2 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-50"
              title="Re-fetch from Microsoft Graph"
              aria-label="Refresh groups list"
            >
              {loading ? '…' : '↻'}
            </button>
            <button
              type="button"
              onClick={() => setShowCreate(true)}
              className="rounded-md bg-slate-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-800"
            >
              + New group
            </button>
          </div>
        </div>
        <input
          type="text"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Search by group name or description…"
          className="mt-2 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-500 focus:outline-none"
        />

        {showCreate && (
          <CreateGroupModal
            acquireToken={acquireToken}
            onClose={() => setShowCreate(false)}
            onCreated={(id) => {
              setShowCreate(false);
              setSelectedId(id);
              setRefetchKey((k) => k + 1);
            }}
          />
        )}

        {loading && <div className="mt-3 text-sm text-slate-500">Loading groups…</div>}
        {error && (
          <div className="mt-3">
            <ErrorBanner message={error} />
          </div>
        )}
        {groups && filtered.length === 0 && !loading && (
          <div className="mt-3 rounded-md border border-slate-200 bg-white p-4 text-sm text-slate-600">
            No groups match the search.
          </div>
        )}

        {filtered.length > 0 && (
          <ul className="mt-3 divide-y divide-slate-100 rounded-lg border border-slate-200 bg-white">
            {filtered.map((g) => (
              <li key={g.id}>
                <button
                  type="button"
                  onClick={() => setSelectedId(g.id)}
                  className={`block w-full px-4 py-3 text-left text-sm hover:bg-slate-50 ${
                    selectedId === g.id ? 'bg-slate-50' : ''
                  }`}
                >
                  <div className="font-medium text-slate-900">{g.displayName}</div>
                  {g.description && (
                    <div className="mt-0.5 text-xs text-slate-500">{g.description}</div>
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <aside className="md:sticky md:top-6 md:self-start">
        {selectedId ? (
          <GroupDetail
            id={selectedId}
            acquireToken={acquireToken}
            onClose={() => setSelectedId(null)}
            onChanged={() => setRefetchKey((k) => k + 1)}
            onDeleted={() => {
              setSelectedId(null);
              setRefetchKey((k) => k + 1);
            }}
          />
        ) : (
          <div className="rounded-lg border border-slate-200 bg-white p-6 text-sm text-slate-500">
            Pick a group on the left to see its members.
          </div>
        )}
      </aside>
    </div>
  );
}

function GroupDetail({
  id,
  acquireToken,
  onClose,
  onChanged,
  onDeleted
}: {
  id: string;
  acquireToken: () => Promise<string>;
  onClose: () => void;
  onChanged: () => void;
  onDeleted: () => void;
}) {
  const [data, setData] = useState<{ group: AdminGroup; members: AdminUser[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [refetch, setRefetch] = useState(0);
  const [showAddMember, setShowAddMember] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setData(null);
    setEditing(false);
    setConfirmingDelete(false);
    setShowAddMember(false);
    (async () => {
      try {
        const token = await acquireToken();
        const res = await fetch(`/api/admin/groups/${encodeURIComponent(id)}`, {
          headers: { Authorization: `Bearer ${token}` }
        });
        if (cancelled) return;
        if (!res.ok) {
          setError(`${res.status} ${(await res.text()).slice(0, 300)}`);
        } else {
          setData((await res.json()) as { group: AdminGroup; members: AdminUser[] });
        }
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id, acquireToken, refetch]);

  const handleDelete = async () => {
    if (busy) return;
    setBusy(true);
    setActionError(null);
    try {
      const token = await acquireToken();
      const res = await fetch(`/api/admin/groups/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` }
      });
      if (!res.ok) {
        setActionError(`${res.status} ${(await res.text()).slice(0, 300)}`);
        return;
      }
      onDeleted();
    } catch (e) {
      setActionError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const handleSave = async (patch: { displayName?: string; description?: string }) => {
    if (busy) return;
    setBusy(true);
    setActionError(null);
    try {
      const token = await acquireToken();
      const res = await fetch(`/api/admin/groups/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(patch)
      });
      if (!res.ok) {
        setActionError(`${res.status} ${(await res.text()).slice(0, 300)}`);
        return;
      }
      setEditing(false);
      setRefetch((n) => n + 1);
      onChanged();
    } catch (e) {
      setActionError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const handleRemoveMember = async (userId: string) => {
    if (busy) return;
    setBusy(true);
    setActionError(null);
    try {
      const token = await acquireToken();
      const res = await fetch(
        `/api/admin/groups/${encodeURIComponent(id)}/members?userId=${encodeURIComponent(userId)}`,
        {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${token}` }
        }
      );
      if (!res.ok) {
        setActionError(`${res.status} ${(await res.text()).slice(0, 300)}`);
        return;
      }
      setRefetch((n) => n + 1);
      // Bubble up: keeps the parent tab's group list (and any
      // membership-derived metadata) consistent with the change.
      onChanged();
    } catch (e) {
      setActionError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const handleAddMember = async (userId: string) => {
    if (busy) return;
    setBusy(true);
    setActionError(null);
    try {
      const token = await acquireToken();
      const res = await fetch(`/api/admin/groups/${encodeURIComponent(id)}/members`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId })
      });
      if (!res.ok) {
        setActionError(`${res.status} ${(await res.text()).slice(0, 300)}`);
        return;
      }
      setShowAddMember(false);
      setRefetch((n) => n + 1);
      onChanged();
    } catch (e) {
      setActionError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-5">
      <div className="flex items-start justify-between gap-3">
        <h3 className="text-base font-semibold text-slate-900">Group detail</h3>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setRefetch((n) => n + 1)}
            disabled={loading || busy}
            className="rounded-md px-2 py-1 text-sm text-slate-500 hover:bg-slate-100 disabled:opacity-50"
            title="Re-fetch from Microsoft Graph"
            aria-label="Refresh group detail"
          >
            {loading ? '…' : '↻'}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-2 py-1 text-sm text-slate-500 hover:bg-slate-100"
            aria-label="Close detail"
          >
            ✕
          </button>
        </div>
      </div>
      {loading && <div className="mt-3 text-sm text-slate-500">Loading…</div>}
      {error && (
        <div className="mt-3">
          <ErrorBanner message={error} />
        </div>
      )}
      {data && !editing && (
        <>
          <dl className="mt-3 space-y-2 text-sm">
            <KV k="Name" v={data.group.displayName} />
            {data.group.description && <KV k="Description" v={data.group.description} />}
            <KV k="Object ID" v={<code className="text-xs">{data.group.id}</code>} />
          </dl>

          <div className="mt-4">
            <div className="flex items-center justify-between">
              <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                {data.members.length} member{data.members.length === 1 ? '' : 's'}
              </div>
              {data.group.isAppAdminGroup ? (
                // No "+ Add member" button on the in-app admin group.
                // Adding admins must happen in Azure portal — see the
                // POST /api/admin/groups/{id}/members guard for the
                // matching server-side enforcement.
                <a
                  href={groupPortalUrl(data.group.id)}
                  target="_blank"
                  rel="noreferrer"
                  className="rounded-md border border-amber-300 bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-800 hover:bg-amber-100"
                  title="Admin elevation must happen in Azure portal — not from this panel"
                >
                  Manage in Azure portal ↗
                </a>
              ) : (
                <button
                  type="button"
                  onClick={() => setShowAddMember((v) => !v)}
                  disabled={busy}
                  className="rounded-md border border-slate-300 px-2 py-0.5 text-[11px] font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-50"
                >
                  {showAddMember ? 'Cancel' : '+ Add member'}
                </button>
              )}
            </div>

            {data.group.isAppAdminGroup && (
              <p className="mt-1 text-[11px] text-amber-800">
                This is the <strong>app-admin group</strong>. Adding members from the in-app
                panel is blocked — admin elevation is a tenant-level decision and must happen in
                Azure portal directly.
              </p>
            )}

            {showAddMember && !data.group.isAppAdminGroup && (
              <AddMemberPicker
                groupId={data.group.id}
                acquireToken={acquireToken}
                excludeIds={new Set(data.members.map((m) => m.id))}
                busy={busy}
                onPick={handleAddMember}
              />
            )}

            {data.members.length === 0 ? (
              <div className="mt-1 text-xs text-slate-400">No direct members.</div>
            ) : (
              <ul className="mt-2 space-y-1 text-xs">
                {data.members.map((u) => (
                  <li
                    key={u.id}
                    className="flex items-center justify-between gap-2 rounded border border-slate-200 bg-slate-50 px-2 py-1"
                  >
                    <div className="min-w-0">
                      <span className="font-medium text-slate-900">{u.displayName}</span>
                      <span className="ml-1 text-slate-500">{u.userPrincipalName}</span>
                    </div>
                    <button
                      type="button"
                      onClick={() => handleRemoveMember(u.id)}
                      disabled={busy}
                      className="shrink-0 rounded p-1 text-red-500 hover:bg-red-50 hover:text-red-700 disabled:opacity-50"
                      title="Remove from group"
                      aria-label={`Remove ${u.displayName}`}
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M3 6h18" />
                        <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                        <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                      </svg>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {actionError && (
            <div className="mt-3 rounded-md border border-red-200 bg-red-50 p-2 text-xs text-red-800">
              {actionError}
            </div>
          )}

          {confirmingDelete ? (
            <ConfirmDelete
              expectedName={data.group.displayName}
              busy={busy}
              onCancel={() => setConfirmingDelete(false)}
              onConfirm={handleDelete}
              label="group"
            />
          ) : (
            <div className="mt-4 flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => setEditing(true)}
                className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100"
              >
                Edit
              </button>
              {/* Delete is hidden for the two permission groups —
                  GROUP_APP_ADMINS_ID and GROUP_UPLOADERS_ID. Deleting
                  either would break the gates that depend on them
                  (admin panel access; upload permission). The backend
                  DELETE handler also 400s these IDs as a defence-in-
                  depth, so even a tampered client can't bypass it. */}
              {!data.group.isAppAdminGroup && !data.group.isUploadersGroup && (
                <button
                  type="button"
                  onClick={() => setConfirmingDelete(true)}
                  className="rounded-md border border-red-300 px-3 py-1.5 text-xs font-medium text-red-700 hover:bg-red-50"
                >
                  Delete group
                </button>
              )}
              {(data.group.isAppAdminGroup || data.group.isUploadersGroup) && (
                <span
                  className="rounded-md border border-slate-200 bg-slate-50 px-2 py-1 text-[11px] text-slate-600"
                  title="This group is referenced by an env var that gates a feature; deleting it would break the gate."
                >
                  Protected · cannot delete
                </span>
              )}
              <a
                href={groupPortalUrl(data.group.id)}
                target="_blank"
                rel="noreferrer"
                className="ml-auto rounded-md bg-slate-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-800"
              >
                Open in Azure portal ↗
              </a>
            </div>
          )}
        </>
      )}

      {data && editing && (
        <EditGroupForm
          group={data.group}
          busy={busy}
          actionError={actionError}
          onCancel={() => {
            setEditing(false);
            setActionError(null);
          }}
          onSave={handleSave}
        />
      )}
    </div>
  );
}

function EditGroupForm({
  group,
  busy,
  actionError,
  onCancel,
  onSave
}: {
  group: AdminGroup;
  busy: boolean;
  actionError: string | null;
  onCancel: () => void;
  onSave: (patch: { displayName?: string; description?: string }) => void;
}) {
  const [displayName, setDisplayName] = useState(group.displayName);
  const [description, setDescription] = useState(group.description || '');

  return (
    <form
      className="mt-3 space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        const patch: { displayName?: string; description?: string } = {};
        if (displayName !== group.displayName) patch.displayName = displayName;
        if (description !== (group.description || '')) patch.description = description;
        onSave(patch);
      }}
    >
      <FormField label="Group name">
        <input
          type="text"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          required
          className="block w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm focus:border-slate-500 focus:outline-none"
        />
      </FormField>
      <FormField label="Description (optional)">
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={3}
          className="block w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm focus:border-slate-500 focus:outline-none"
        />
      </FormField>
      {actionError && (
        <div className="rounded-md border border-red-200 bg-red-50 p-2 text-xs text-red-800">
          {actionError}
        </div>
      )}
      <div className="flex justify-end gap-2 pt-2">
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={busy}
          className="rounded-md bg-slate-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-800 disabled:opacity-50"
        >
          {busy ? 'Saving…' : 'Save'}
        </button>
      </div>
    </form>
  );
}

function CreateGroupModal({
  acquireToken,
  onClose,
  onCreated
}: {
  acquireToken: () => Promise<string>;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const [displayName, setDisplayName] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const token = await acquireToken();
      const res = await fetch('/api/admin/groups', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ displayName: displayName.trim(), description: description.trim() || undefined })
      });
      if (!res.ok) {
        setError(`${res.status} ${(await res.text()).slice(0, 400)}`);
        return;
      }
      const data = (await res.json()) as { group: { id: string } };
      onCreated(data.group.id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="Create security group" onClose={onClose}>
      <form className="space-y-3" onSubmit={handleSubmit}>
        <FormField
          label="Group name"
          hint="Convention: prefix with `group-` (e.g. group-hr-readers). Security group; appears in users' transitiveMemberOf claim."
        >
          <input
            type="text"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="group-hr-readers"
            required
            autoFocus
            className="block w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm focus:border-slate-500 focus:outline-none"
          />
        </FormField>
        <FormField label="Description (optional)" hint="What kind of content this group grants access to.">
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Members can read HR-tagged docs in the demo."
            rows={3}
            className="block w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm focus:border-slate-500 focus:outline-none"
          />
        </FormField>
        {error && (
          <div className="rounded-md border border-red-200 bg-red-50 p-2 text-xs text-red-800">
            {error}
          </div>
        )}
        <div className="flex items-center justify-end gap-2 border-t pt-3">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded-md border border-slate-300 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-100 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={busy || !displayName.trim()}
            className="rounded-md bg-slate-900 px-4 py-1.5 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
          >
            {busy ? 'Creating…' : 'Create group'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function AddToGroupPicker({
  acquireToken,
  excludeIds,
  busy,
  onPick
}: {
  acquireToken: () => Promise<string>;
  excludeIds: Set<string>;
  busy: boolean;
  onPick: (groupId: string) => void;
}) {
  const [groups, setGroups] = useState<AdminGroup[] | null>(null);
  const [filter, setFilter] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const token = await acquireToken();
        const res = await fetch('/api/admin/groups', {
          headers: { Authorization: `Bearer ${token}` }
        });
        if (cancelled || !res.ok) return;
        const data = (await res.json()) as { groups: AdminGroup[] };
        setGroups(data.groups);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [acquireToken]);

  const matches = useMemo(() => {
    if (!groups) return [];
    const q = filter.trim().toLowerCase();
    // Hide the in-app admin group — adding users to it is blocked
    // server-side (POST /members guard), so don't even offer it as an
    // option. Same idea for uploaders if you want to extend later.
    const list = groups.filter((g) => !excludeIds.has(g.id) && !g.isAppAdminGroup);
    if (!q) return list.slice(0, 10);
    return list
      .filter(
        (g) =>
          g.displayName.toLowerCase().includes(q) ||
          (g.description || '').toLowerCase().includes(q)
      )
      .slice(0, 10);
  }, [groups, filter, excludeIds]);

  return (
    <div className="mt-2 rounded-md border border-slate-200 bg-white p-2">
      <input
        type="text"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        placeholder="Search group by name or description…"
        autoFocus
        className="block w-full rounded-md border border-slate-300 px-2 py-1 text-xs focus:border-slate-500 focus:outline-none"
      />
      {loading && <div className="mt-2 text-xs text-slate-500">Loading…</div>}
      {!loading && groups && (
        <ul className="mt-2 max-h-48 space-y-0.5 overflow-y-auto text-xs">
          {matches.length === 0 ? (
            <li className="text-slate-400">No matching group.</li>
          ) : (
            matches.map((g) => (
              <li key={g.id}>
                <button
                  type="button"
                  onClick={() => onPick(g.id)}
                  disabled={busy}
                  className="block w-full rounded px-2 py-1 text-left hover:bg-slate-100 disabled:opacity-50"
                >
                  <span className="font-medium text-slate-900">{g.displayName}</span>
                  {g.description && (
                    <span className="ml-1 text-slate-500">— {g.description}</span>
                  )}
                </button>
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}

function AddMemberPicker({
  groupId: _groupId,
  acquireToken,
  excludeIds,
  busy,
  onPick
}: {
  groupId: string;
  acquireToken: () => Promise<string>;
  excludeIds: Set<string>;
  busy: boolean;
  onPick: (userId: string) => void;
}) {
  const [users, setUsers] = useState<AdminUser[] | null>(null);
  const [filter, setFilter] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const token = await acquireToken();
        const res = await fetch('/api/admin/users', {
          headers: { Authorization: `Bearer ${token}` }
        });
        if (cancelled || !res.ok) return;
        const data = (await res.json()) as { users: AdminUser[] };
        setUsers(data.users);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [acquireToken]);

  const matches = useMemo(() => {
    if (!users) return [];
    const q = filter.trim().toLowerCase();
    // Hide protected users (admin-group members + #EXT# system accounts)
    // from the picker — they're view-only, and the backend would reject
    // an add anyway. Keeps the list focused on actually addable users.
    const list = users.filter(
      (u) => !excludeIds.has(u.id) && !u.isAppAdmin && !u.isSystemAccount
    );
    if (!q) return list.slice(0, 10);
    return list
      .filter(
        (u) =>
          u.displayName.toLowerCase().includes(q) ||
          u.userPrincipalName.toLowerCase().includes(q)
      )
      .slice(0, 10);
  }, [users, filter, excludeIds]);

  return (
    <div className="mt-2 rounded-md border border-slate-200 bg-white p-2">
      <input
        type="text"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        placeholder="Search user by name or UPN…"
        autoFocus
        className="block w-full rounded-md border border-slate-300 px-2 py-1 text-xs focus:border-slate-500 focus:outline-none"
      />
      {loading && <div className="mt-2 text-xs text-slate-500">Loading…</div>}
      {!loading && users && (
        <ul className="mt-2 max-h-48 space-y-0.5 overflow-y-auto text-xs">
          {matches.length === 0 ? (
            <li className="text-slate-400">No matching user.</li>
          ) : (
            matches.map((u) => (
              <li key={u.id}>
                <button
                  type="button"
                  onClick={() => onPick(u.id)}
                  disabled={busy}
                  className="block w-full rounded px-2 py-1 text-left hover:bg-slate-100 disabled:opacity-50"
                >
                  <span className="font-medium text-slate-900">{u.displayName}</span>
                  <span className="ml-1 text-slate-500">{u.userPrincipalName}</span>
                </button>
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}
