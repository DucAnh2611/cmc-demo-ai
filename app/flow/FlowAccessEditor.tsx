'use client';

import { useEffect, useMemo, useState } from 'react';

/**
 * Shared editor for the /flow access policy.
 *
 * Renders a radio for the access mode plus (when `restricted` is chosen)
 * two multi-select sections — groups and individual users. Designed to
 * be embedded in:
 *   - The "Access" tab of /admin
 *   - An inline panel on /flow (visible to admins only)
 *
 * Both contexts inject the parent's `acquireToken` so this component
 * doesn't have to know about MSAL directly. On save, calls `onSaved`
 * with the new policy so the parent can refresh whatever it shows.
 */

export type FlowAccessMode = 'public' | 'anyone-with-link' | 'restricted';

export interface FlowAccessPolicy {
  mode: FlowAccessMode;
  allowedGroups: string[];
  allowedUsers: string[];
  /** Share token for `anyone-with-link` mode. Empty when never
   *  generated. */
  linkToken: string;
  updatedBy: string;
  updatedAt: string;
}

interface AdminUser {
  id: string;
  displayName: string;
  userPrincipalName: string;
}

interface AdminGroup {
  id: string;
  displayName: string;
  description?: string;
}

export function FlowAccessEditor({
  acquireToken,
  onSaved
}: {
  acquireToken: () => Promise<string>;
  onSaved?: (policy: FlowAccessPolicy) => void;
}) {
  const [policy, setPolicy] = useState<FlowAccessPolicy | null>(null);
  const [mode, setMode] = useState<FlowAccessMode>('anyone-with-link');
  const [allowedGroups, setAllowedGroups] = useState<string[]>([]);
  const [allowedUsers, setAllowedUsers] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedFlash, setSavedFlash] = useState(false);

  const [users, setUsers] = useState<AdminUser[]>([]);
  const [groups, setGroups] = useState<AdminGroup[]>([]);
  const [pickingUsers, setPickingUsers] = useState(false);
  const [pickingGroups, setPickingGroups] = useState(false);

  // Load the current policy + the picker data in parallel on mount.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const token = await acquireToken();
        const [policyRes, usersRes, groupsRes] = await Promise.all([
          fetch('/api/admin/flow-access', { headers: { Authorization: `Bearer ${token}` } }),
          fetch('/api/admin/users', { headers: { Authorization: `Bearer ${token}` } }),
          fetch('/api/admin/groups', { headers: { Authorization: `Bearer ${token}` } })
        ]);
        if (cancelled) return;
        if (policyRes.ok) {
          const data = (await policyRes.json()) as { policy: FlowAccessPolicy };
          setPolicy(data.policy);
          setMode(data.policy.mode);
          setAllowedGroups(data.policy.allowedGroups);
          setAllowedUsers(data.policy.allowedUsers);
        } else {
          setError(`${policyRes.status} ${(await policyRes.text()).slice(0, 200)}`);
        }
        if (usersRes.ok) {
          const data = (await usersRes.json()) as { users: AdminUser[] };
          setUsers(data.users);
        }
        if (groupsRes.ok) {
          const data = (await groupsRes.json()) as { groups: AdminGroup[] };
          setGroups(data.groups);
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
  }, [acquireToken]);

  const handleSave = async (opts: { regenerateLink?: boolean } = {}) => {
    if (saving) return;
    setSaving(true);
    setError(null);
    setSavedFlash(false);
    try {
      const token = await acquireToken();
      const body: Record<string, unknown> = { mode, allowedGroups, allowedUsers };
      if (opts.regenerateLink) body.regenerateLink = true;
      const res = await fetch('/api/admin/flow-access', {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      if (!res.ok) {
        setError(`${res.status} ${(await res.text()).slice(0, 300)}`);
        return;
      }
      const data = (await res.json()) as { policy: FlowAccessPolicy };
      setPolicy(data.policy);
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 2500);
      onSaved?.(data.policy);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  // Build the share URL the admin can copy. Uses the policy's current
  // saved token — regenerating produces a NEW URL and invalidates the
  // old one. Shown only when mode is `anyone-with-link` AND a token
  // exists in the saved policy.
  const shareUrl = (() => {
    if (typeof window === 'undefined') return '';
    if (!policy?.linkToken) return '';
    return `${window.location.origin}/flow?t=${policy.linkToken}`;
  })();
  const [copied, setCopied] = useState(false);
  const handleCopy = async () => {
    if (!shareUrl) return;
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard blocked — admin can select+copy manually */
    }
  };

  const isDirty =
    policy !== null &&
    (policy.mode !== mode ||
      policy.allowedGroups.length !== allowedGroups.length ||
      policy.allowedUsers.length !== allowedUsers.length ||
      policy.allowedGroups.some((g, i) => g !== allowedGroups[i]) ||
      policy.allowedUsers.some((u, i) => u !== allowedUsers[i]));

  const isRestricted = mode === 'restricted';
  const restrictedNoOne =
    isRestricted && allowedGroups.length === 0 && allowedUsers.length === 0;

  if (loading) {
    return <div className="text-sm text-slate-500">Loading access policy…</div>;
  }

  return (
    <div className="space-y-4 text-sm">
      <fieldset className="space-y-2">
        <legend className="text-xs font-semibold uppercase tracking-wide text-slate-500">
          Who can read /flow?
        </legend>
        <RadioRow
          checked={mode === 'public'}
          onChange={() => setMode('public')}
          label="Public"
          description="Discoverable / shareable. Anyone can read, signed in or not."
        />
        <RadioRow
          checked={mode === 'anyone-with-link'}
          onChange={() => setMode('anyone-with-link')}
          label="Anyone with link"
          description="Same open access as public, framed as share-by-URL. Both signed-in and unsigned visitors read it."
        />
        <RadioRow
          checked={mode === 'restricted'}
          onChange={() => setMode('restricted')}
          label="Restricted"
          description="Only members of the listed groups OR specific people below. Admins always pass."
        />
      </fieldset>

      {mode === 'anyone-with-link' && policy?.mode === 'anyone-with-link' && shareUrl && (
        <div className="rounded-md border border-slate-200 bg-slate-50 p-3">
          <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            Share link
          </div>
          <p className="mt-1 text-[11px] text-slate-500">
            Only this exact URL grants access. Send it to anyone who should read /flow.
            Regenerating invalidates the old link.
          </p>
          <div className="mt-2 flex items-stretch gap-2">
            <input
              type="text"
              readOnly
              value={shareUrl}
              onFocus={(e) => e.currentTarget.select()}
              className="flex-1 rounded-md border border-slate-300 bg-white px-2 py-1.5 font-mono text-[11px] focus:border-slate-500 focus:outline-none"
            />
            <button
              type="button"
              onClick={handleCopy}
              className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100"
            >
              {copied ? 'Copied' : 'Copy'}
            </button>
            <button
              type="button"
              onClick={() => handleSave({ regenerateLink: true })}
              disabled={saving}
              className="rounded-md border border-amber-300 bg-amber-50 px-3 py-1.5 text-xs font-medium text-amber-800 hover:bg-amber-100 disabled:opacity-50"
              title="Mint a new token and invalidate the old URL"
            >
              Regenerate
            </button>
          </div>
        </div>
      )}
      {mode === 'anyone-with-link' && policy?.mode !== 'anyone-with-link' && (
        <div className="rounded-md border border-slate-200 bg-slate-50 p-3 text-[11px] text-slate-600">
          Save to generate a share link. The URL will appear here after the first save.
        </div>
      )}

      {isRestricted && (
        <>
          <AllowedList
            heading="Groups"
            subtitle="Anyone in these groups gets access."
            kind="group"
            ids={allowedGroups}
            onRemove={(id) => setAllowedGroups((prev) => prev.filter((x) => x !== id))}
            onAdd={() => setPickingGroups(true)}
            resolveName={(id) => {
              const g = groups.find((x) => x.id === id);
              return g ? g.displayName : `Unknown · ${id.slice(0, 8)}…`;
            }}
            resolveSecondary={(id) => groups.find((x) => x.id === id)?.description || ''}
          />
          <AllowedList
            heading="People"
            subtitle="Specific users — additive on top of the groups above."
            kind="user"
            ids={allowedUsers}
            onRemove={(id) => setAllowedUsers((prev) => prev.filter((x) => x !== id))}
            onAdd={() => setPickingUsers(true)}
            resolveName={(id) => {
              const u = users.find((x) => x.id === id);
              return u ? u.displayName : `Unknown · ${id.slice(0, 8)}…`;
            }}
            resolveSecondary={(id) => users.find((x) => x.id === id)?.userPrincipalName || ''}
          />

          {restrictedNoOne && (
            <div className="rounded-md border border-amber-300 bg-amber-50 p-2 text-[11px] text-amber-900">
              ⚠ Restricted mode with no groups and no people — currently <strong>only admins</strong> can
              read /flow. Add a group or a person, or switch to a different mode.
            </div>
          )}
        </>
      )}

      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 p-2 text-xs text-red-800">
          {error}
        </div>
      )}

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => handleSave()}
          disabled={saving || !isDirty}
          className="rounded-md bg-slate-900 px-4 py-1.5 text-xs font-medium text-white hover:bg-slate-800 disabled:opacity-50"
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
        {!isDirty && policy && (
          <span className="text-[11px] text-slate-400">No changes.</span>
        )}
        {savedFlash && <span className="text-[11px] text-emerald-700">✓ Saved</span>}
        {policy?.updatedAt && (
          <span className="ml-auto text-[10px] text-slate-400">
            Last updated {new Date(policy.updatedAt).toLocaleString()}
          </span>
        )}
      </div>

      {pickingGroups && (
        <FlowPickerModal
          title="Add groups"
          items={groups.map((g) => ({
            id: g.id,
            primary: g.displayName,
            secondary: g.description || '',
            disabled: allowedGroups.includes(g.id)
          }))}
          onCancel={() => setPickingGroups(false)}
          onAdd={(ids) => {
            setAllowedGroups((prev) => Array.from(new Set([...prev, ...ids])));
            setPickingGroups(false);
          }}
        />
      )}
      {pickingUsers && (
        <FlowPickerModal
          title="Add people"
          items={users.map((u) => ({
            id: u.id,
            primary: u.displayName,
            secondary: u.userPrincipalName,
            disabled: allowedUsers.includes(u.id)
          }))}
          onCancel={() => setPickingUsers(false)}
          onAdd={(ids) => {
            setAllowedUsers((prev) => Array.from(new Set([...prev, ...ids])));
            setPickingUsers(false);
          }}
        />
      )}
    </div>
  );
}

function RadioRow({
  checked,
  onChange,
  label,
  description
}: {
  checked: boolean;
  onChange: () => void;
  label: string;
  description: string;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-2 rounded-md border border-slate-200 bg-white p-2 hover:bg-slate-50">
      <input type="radio" checked={checked} onChange={onChange} className="mt-0.5 h-4 w-4" />
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-slate-900">{label}</div>
        <div className="text-[11px] text-slate-500">{description}</div>
      </div>
    </label>
  );
}

function AllowedList({
  heading,
  subtitle,
  kind,
  ids,
  onRemove,
  onAdd,
  resolveName,
  resolveSecondary
}: {
  heading: string;
  subtitle: string;
  kind: 'user' | 'group';
  ids: string[];
  onRemove: (id: string) => void;
  onAdd: () => void;
  resolveName: (id: string) => string;
  resolveSecondary: (id: string) => string;
}) {
  return (
    <div>
      <div className="flex items-center justify-between">
        <div>
          <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            {heading} ({ids.length})
          </div>
          <div className="text-[11px] text-slate-500">{subtitle}</div>
        </div>
        <button
          type="button"
          onClick={onAdd}
          className="rounded-md border border-slate-300 px-2 py-0.5 text-[11px] font-medium text-slate-700 hover:bg-slate-100"
        >
          + Add {kind === 'user' ? 'people' : 'groups'}
        </button>
      </div>
      {ids.length === 0 ? (
        <div className="mt-2 rounded-md border border-dashed border-slate-300 p-2 text-center text-[11px] text-slate-400">
          None added.
        </div>
      ) : (
        <ul className="mt-2 space-y-1">
          {ids.map((id) => (
            <li
              key={id}
              className="flex items-center gap-2 rounded border border-slate-200 bg-slate-50 px-2 py-1"
            >
              <div className="min-w-0 flex-1">
                <div className="truncate text-xs font-medium text-slate-900">{resolveName(id)}</div>
                {resolveSecondary(id) && (
                  <div className="truncate text-[10px] text-slate-500">{resolveSecondary(id)}</div>
                )}
              </div>
              <button
                type="button"
                onClick={() => onRemove(id)}
                className="rounded p-1 text-red-500 hover:bg-red-50 hover:text-red-700"
                title="Remove"
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

interface FlowPickerItem {
  id: string;
  primary: string;
  secondary?: string;
  disabled?: boolean;
}

function FlowPickerModal({
  title,
  items,
  onCancel,
  onAdd
}: {
  title: string;
  items: FlowPickerItem[];
  onCancel: () => void;
  onAdd: (ids: string[]) => void;
}) {
  const [filter, setFilter] = useState('');
  const [picked, setPicked] = useState<Set<string>>(new Set());

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return items;
    return items.filter(
      (i) =>
        i.primary.toLowerCase().includes(q) || (i.secondary || '').toLowerCase().includes(q)
    );
  }, [items, filter]);

  const toggle = (id: string) => {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div className="fixed inset-0 z-60 flex items-center justify-center bg-black/40 p-4">
      <div
        className="flex max-h-[85vh] w-full max-w-lg flex-col overflow-hidden rounded-xl bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="border-b px-5 pt-4 pb-3">
          <h4 className="text-sm font-semibold text-slate-900">{title}</h4>
          <input
            type="text"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Search…"
            autoFocus
            className="mt-3 block w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm focus:border-slate-500 focus:outline-none"
          />
        </div>
        <div className="flex-1 overflow-y-auto px-2 py-2">
          {filtered.length === 0 ? (
            <div className="px-3 py-4 text-center text-xs text-slate-400">No matches.</div>
          ) : (
            <ul className="space-y-0.5">
              {filtered.map((it) => {
                const isPicked = picked.has(it.id);
                return (
                  <li key={it.id}>
                    <label
                      className={`flex items-center gap-2 rounded px-2 py-1.5 text-sm ${
                        it.disabled
                          ? 'cursor-not-allowed opacity-40'
                          : 'cursor-pointer hover:bg-slate-50'
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={isPicked}
                        disabled={it.disabled}
                        onChange={() => toggle(it.id)}
                        className="h-4 w-4"
                      />
                      <div className="min-w-0 flex-1">
                        <div className="truncate font-medium text-slate-900">{it.primary}</div>
                        {it.secondary && (
                          <div className="truncate text-[10px] text-slate-500">{it.secondary}</div>
                        )}
                      </div>
                      {it.disabled && (
                        <span className="text-[10px] uppercase tracking-wide text-slate-400">
                          already added
                        </span>
                      )}
                    </label>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
        <div className="flex justify-end gap-2 border-t bg-slate-50 px-5 py-3">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={picked.size === 0}
            onClick={() => onAdd(Array.from(picked))}
            className="rounded-md bg-slate-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-800 disabled:opacity-50"
          >
            Add {picked.size > 0 ? `${picked.size} ` : ''}
            {picked.size === 1 ? 'item' : 'items'}
          </button>
        </div>
      </div>
    </div>
  );
}
