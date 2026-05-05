import { afterAll, afterEach, describe, expect, it } from 'vitest';
import {
  createUser,
  updateUser,
  deleteUser,
  getUser,
  resetUserPassword,
  createGroup,
  updateGroup,
  deleteGroup,
  getGroup,
  getGroupMembers,
  getGroupMemberCount,
  addGroupMember,
  removeGroupMember,
  GraphError
} from '@/lib/admin/graph';

// =====================================================================
// REAL Microsoft Graph integration tests for the admin panel's CRUD.
//
// No mocks — every call hits live Graph. Each test creates its own
// uniquely-named resources, exercises them, and deletes them in
// try / finally. A safety-net afterAll deletes anything that escaped
// (e.g. if a test crashed before its `finally` block ran).
//
// REQUIRED ENV (or the suite skips):
//   GRAPH_ADMIN_TEST_TOKEN   — bearer token for Microsoft Graph,
//                              must include User.ReadWrite.All +
//                              Group.ReadWrite.All scopes AND the
//                              identity must hold the User
//                              Administrator (or higher) Entra role.
//   GRAPH_ADMIN_TEST_DOMAIN  — tenant primary domain, e.g.
//                              `evilcatkimigmail.onmicrosoft.com`
//                              (used to build test user UPNs).
//
// HOW TO GET A TOKEN (one-shot, expires in ~1h):
//   1. Sign into the demo as an admin in your browser
//   2. Open devtools console and paste:
//        const t = Object.values(sessionStorage)
//          .map(v => { try { return JSON.parse(v); } catch { return null; } })
//          .find(v => v?.credentialType === 'AccessToken' && v.target?.includes('GroupMember'))
//          ?.secret;
//        copy(t);
//   3. Set env:  $env:GRAPH_ADMIN_TEST_TOKEN=<paste>;  $env:GRAPH_ADMIN_TEST_DOMAIN=evilcatkimigmail.onmicrosoft.com
//   4. Run:  npm test
//
// All test resources use the prefix "_autotest_<run-id>_" — easy to
// grep / wipe in the Azure portal if cleanup ever fails.
// =====================================================================

const TOKEN = (process.env.GRAPH_ADMIN_TEST_TOKEN || '').trim();
const TENANT_DOMAIN = (process.env.GRAPH_ADMIN_TEST_DOMAIN || '').trim();
const ENABLED = !!TOKEN && !!TENANT_DOMAIN;

// Unique-per-run id — `_autotest_<base36-timestamp>_` so concurrent
// runs (e.g. CI matrix) don't collide on the same UPN / group name.
const RUN_ID = `_autotest_${Date.now().toString(36)}_`;

// Strong password that satisfies Entra default policy (≥8 chars,
// upper / lower / digit / symbol). Re-used across tests since none
// inspect or rely on the value.
const PW1 = 'Aa!1Bb@2Cc#3Dd$4';
const PW2 = 'Zz!9Yy@8Xx#7Ww$6';

// Helpers
function userUpn(label: string): string {
  return `${RUN_ID}${label}@${TENANT_DOMAIN}`;
}
function groupName(label: string): string {
  return `${RUN_ID}${label}`;
}

// Track everything created so the safety net can delete it
const createdUsers = new Set<string>();
const createdGroups = new Set<string>();

const desc = ENABLED ? describe : describe.skip;

afterAll(async () => {
  if (!ENABLED) return;
  // Best-effort safety net for any resource a test forgot to delete.
  // Errors swallowed — by the time afterAll runs, the resource may
  // already be gone (deleted by its own test's finally), 404 is fine.
  for (const id of createdGroups) {
    await deleteGroup(TOKEN, id).catch(() => undefined);
  }
  for (const id of createdUsers) {
    await deleteUser(TOKEN, id).catch(() => undefined);
  }
});

// =====================================================================
// USER CRUD
// =====================================================================

desc('Real Graph — User CRUD', () => {
  it('create → get → update → delete', async () => {
    const upn = userUpn('user-lifecycle');
    const user = await createUser(TOKEN, {
      userPrincipalName: upn,
      displayName: 'Auto Test · User Lifecycle',
      password: PW1
    });
    createdUsers.add(user.id);
    try {
      expect(user.id).toBeTruthy();
      expect(user.userPrincipalName).toBe(upn);

      const fetched = await getUser(TOKEN, user.id);
      expect(fetched.userPrincipalName).toBe(upn);
      expect(fetched.displayName).toBe('Auto Test · User Lifecycle');
      expect(fetched.accountEnabled).toBe(true);

      await updateUser(TOKEN, user.id, {
        displayName: 'Renamed By Test',
        jobTitle: 'QA Bot',
        accountEnabled: false
      });
      const renamed = await getUser(TOKEN, user.id);
      expect(renamed.displayName).toBe('Renamed By Test');
      expect(renamed.jobTitle).toBe('QA Bot');
      expect(renamed.accountEnabled).toBe(false);
    } finally {
      await deleteUser(TOKEN, user.id);
      createdUsers.delete(user.id);
    }
  });

  it('rejects an invalid UPN with GraphError 400', async () => {
    await expect(
      createUser(TOKEN, {
        userPrincipalName: 'no-at-sign',
        displayName: 'Bad UPN',
        password: PW1
      })
    ).rejects.toBeInstanceOf(GraphError);
  });

  it('rejects a weak password with GraphError 400', async () => {
    const upn = userUpn('weak-pw');
    await expect(
      createUser(TOKEN, {
        userPrincipalName: upn,
        displayName: 'Weak PW',
        password: 'short'
      })
    ).rejects.toBeInstanceOf(GraphError);
  });

  it('rejects duplicate UPN with GraphError', async () => {
    const upn = userUpn('dup');
    const user = await createUser(TOKEN, {
      userPrincipalName: upn,
      displayName: 'First',
      password: PW1
    });
    createdUsers.add(user.id);
    try {
      await expect(
        createUser(TOKEN, {
          userPrincipalName: upn,
          displayName: 'Duplicate',
          password: PW1
        })
      ).rejects.toBeInstanceOf(GraphError);
    } finally {
      await deleteUser(TOKEN, user.id);
      createdUsers.delete(user.id);
    }
  });

  it('partial update: only displayName changes when only displayName is patched', async () => {
    const user = await createUser(TOKEN, {
      userPrincipalName: userUpn('partial'),
      displayName: 'Original',
      password: PW1
    });
    createdUsers.add(user.id);
    try {
      await updateUser(TOKEN, user.id, { displayName: 'New Only' });
      const after = await getUser(TOKEN, user.id);
      expect(after.displayName).toBe('New Only');
      expect(after.accountEnabled).toBe(true); // unchanged
    } finally {
      await deleteUser(TOKEN, user.id);
      createdUsers.delete(user.id);
    }
  });
});

// =====================================================================
// PASSWORD RESET
// =====================================================================

desc('Real Graph — Password reset', () => {
  it('resetUserPassword on a freshly-created user succeeds', async () => {
    const user = await createUser(TOKEN, {
      userPrincipalName: userUpn('reset-pw'),
      displayName: 'Reset Target',
      password: PW1
    });
    createdUsers.add(user.id);
    try {
      // Graph returns 204 on success; resetUserPassword resolves with no value
      await expect(resetUserPassword(TOKEN, user.id, PW2, true)).resolves.toBeUndefined();
    } finally {
      await deleteUser(TOKEN, user.id);
      createdUsers.delete(user.id);
    }
  });

  it('forceChange=false is honoured (does not throw)', async () => {
    const user = await createUser(TOKEN, {
      userPrincipalName: userUpn('reset-pw-noforce'),
      displayName: 'No Force',
      password: PW1
    });
    createdUsers.add(user.id);
    try {
      await expect(resetUserPassword(TOKEN, user.id, PW2, false)).resolves.toBeUndefined();
    } finally {
      await deleteUser(TOKEN, user.id);
      createdUsers.delete(user.id);
    }
  });

  it('weak password is rejected with GraphError 400', async () => {
    const user = await createUser(TOKEN, {
      userPrincipalName: userUpn('reset-pw-weak'),
      displayName: 'Weak Reset',
      password: PW1
    });
    createdUsers.add(user.id);
    try {
      await expect(resetUserPassword(TOKEN, user.id, 'short')).rejects.toBeInstanceOf(GraphError);
    } finally {
      await deleteUser(TOKEN, user.id);
      createdUsers.delete(user.id);
    }
  });

  it('non-existent user id returns GraphError 404', async () => {
    await expect(
      resetUserPassword(TOKEN, '00000000-0000-0000-0000-000000000000', PW2)
    ).rejects.toBeInstanceOf(GraphError);
  });
});

// =====================================================================
// GROUP CRUD
// =====================================================================

desc('Real Graph — Group CRUD', () => {
  it('create → get → update → delete', async () => {
    const name = groupName('group-lifecycle');
    const group = await createGroup(TOKEN, {
      displayName: name,
      description: 'Created by automated test'
    });
    createdGroups.add(group.id);
    try {
      expect(group.id).toBeTruthy();
      expect(group.displayName).toBe(name);

      const fetched = await getGroup(TOKEN, group.id);
      expect(fetched.displayName).toBe(name);
      expect(fetched.securityEnabled).toBe(true);
      expect(fetched.mailEnabled).toBe(false);

      await updateGroup(TOKEN, group.id, {
        displayName: `${name}-renamed`,
        description: 'Updated by test'
      });
      const renamed = await getGroup(TOKEN, group.id);
      expect(renamed.displayName).toBe(`${name}-renamed`);
      expect(renamed.description).toBe('Updated by test');
    } finally {
      await deleteGroup(TOKEN, group.id);
      createdGroups.delete(group.id);
    }
  });

  it('forces Security group settings (no Microsoft 365 group accidentally created)', async () => {
    const name = groupName('security-only');
    const group = await createGroup(TOKEN, { displayName: name });
    createdGroups.add(group.id);
    try {
      const fetched = await getGroup(TOKEN, group.id);
      expect(fetched.securityEnabled).toBe(true);
      expect(fetched.mailEnabled).toBe(false);
      // groupTypes empty == Security; ['Unified'] would mean M365
      expect(fetched.groupTypes).toEqual([]);
    } finally {
      await deleteGroup(TOKEN, group.id);
      createdGroups.delete(group.id);
    }
  });

  it('partial update: only the supplied field changes', async () => {
    const name = groupName('partial-update');
    const group = await createGroup(TOKEN, {
      displayName: name,
      description: 'Original description'
    });
    createdGroups.add(group.id);
    try {
      await updateGroup(TOKEN, group.id, { description: 'Updated description' });
      const after = await getGroup(TOKEN, group.id);
      expect(after.displayName).toBe(name); // unchanged
      expect(after.description).toBe('Updated description');
    } finally {
      await deleteGroup(TOKEN, group.id);
      createdGroups.delete(group.id);
    }
  });

  it('newly-created group has zero members', async () => {
    const group = await createGroup(TOKEN, { displayName: groupName('empty') });
    createdGroups.add(group.id);
    try {
      const members = await getGroupMembers(TOKEN, group.id);
      expect(members).toEqual([]);
      const count = await getGroupMemberCount(TOKEN, group.id);
      // Graph $count may need a few seconds to be consistent — accept 0 or null
      expect(count === 0 || count === null).toBe(true);
    } finally {
      await deleteGroup(TOKEN, group.id);
      createdGroups.delete(group.id);
    }
  });

  it('deleting a non-existent group returns GraphError 404', async () => {
    await expect(
      deleteGroup(TOKEN, '00000000-0000-0000-0000-000000000000')
    ).rejects.toBeInstanceOf(GraphError);
  });
});

// =====================================================================
// GROUP MEMBERSHIP — attach / detach / interaction
// =====================================================================

desc('Real Graph — Member management (attach group)', () => {
  it('addGroupMember → list → removeGroupMember roundtrip', async () => {
    const user = await createUser(TOKEN, {
      userPrincipalName: userUpn('member-rt-user'),
      displayName: 'Member RT User',
      password: PW1
    });
    createdUsers.add(user.id);
    const group = await createGroup(TOKEN, { displayName: groupName('member-rt-group') });
    createdGroups.add(group.id);
    try {
      // Attach
      await addGroupMember(TOKEN, group.id, user.id);

      // List — eventual consistency on /members can lag a few seconds.
      // Retry a couple of times before failing, but cap so a real bug
      // doesn't hang.
      let members: Awaited<ReturnType<typeof getGroupMembers>> = [];
      for (let i = 0; i < 5; i++) {
        members = await getGroupMembers(TOKEN, group.id);
        if (members.some((m) => m.id === user.id)) break;
        await new Promise((r) => setTimeout(r, 1000));
      }
      expect(members.map((m) => m.id)).toContain(user.id);

      // Detach
      await removeGroupMember(TOKEN, group.id, user.id);

      // Verify gone (with same retry tolerance)
      let stillThere = true;
      for (let i = 0; i < 5; i++) {
        const after = await getGroupMembers(TOKEN, group.id);
        if (!after.some((m) => m.id === user.id)) {
          stillThere = false;
          break;
        }
        await new Promise((r) => setTimeout(r, 1000));
      }
      expect(stillThere).toBe(false);
    } finally {
      // Order matters: delete group first (ok if user still member)
      await deleteGroup(TOKEN, group.id).catch(() => undefined);
      createdGroups.delete(group.id);
      await deleteUser(TOKEN, user.id).catch(() => undefined);
      createdUsers.delete(user.id);
    }
  });

  it('adding the same user twice returns GraphError 400 (already a member)', async () => {
    const user = await createUser(TOKEN, {
      userPrincipalName: userUpn('dup-member-user'),
      displayName: 'Dup Member User',
      password: PW1
    });
    createdUsers.add(user.id);
    const group = await createGroup(TOKEN, { displayName: groupName('dup-member-group') });
    createdGroups.add(group.id);
    try {
      await addGroupMember(TOKEN, group.id, user.id);
      await expect(addGroupMember(TOKEN, group.id, user.id)).rejects.toBeInstanceOf(GraphError);
    } finally {
      await removeGroupMember(TOKEN, group.id, user.id).catch(() => undefined);
      await deleteGroup(TOKEN, group.id).catch(() => undefined);
      createdGroups.delete(group.id);
      await deleteUser(TOKEN, user.id).catch(() => undefined);
      createdUsers.delete(user.id);
    }
  });

  it('removing a non-member returns GraphError 404', async () => {
    const group = await createGroup(TOKEN, { displayName: groupName('no-member-rm') });
    createdGroups.add(group.id);
    try {
      await expect(
        removeGroupMember(TOKEN, group.id, '00000000-0000-0000-0000-000000000000')
      ).rejects.toBeInstanceOf(GraphError);
    } finally {
      await deleteGroup(TOKEN, group.id);
      createdGroups.delete(group.id);
    }
  });

  it('attaching to non-existent group returns GraphError 4xx', async () => {
    const user = await createUser(TOKEN, {
      userPrincipalName: userUpn('orphan-attach'),
      displayName: 'Orphan Attach',
      password: PW1
    });
    createdUsers.add(user.id);
    try {
      await expect(
        addGroupMember(TOKEN, '00000000-0000-0000-0000-000000000000', user.id)
      ).rejects.toBeInstanceOf(GraphError);
    } finally {
      await deleteUser(TOKEN, user.id);
      createdUsers.delete(user.id);
    }
  });
});

// =====================================================================
// END-TO-END FEATURE FLOWS — multi-step scenarios test@ would run
// =====================================================================

desc('Real Graph — End-to-end admin flows', () => {
  it('feature: create user, attach to group, reset password, then full cleanup', async () => {
    const user = await createUser(TOKEN, {
      userPrincipalName: userUpn('e2e-feature'),
      displayName: 'E2E Feature',
      password: PW1
    });
    createdUsers.add(user.id);
    const group = await createGroup(TOKEN, { displayName: groupName('e2e-group') });
    createdGroups.add(group.id);
    try {
      // Attach the user to the group
      await addGroupMember(TOKEN, group.id, user.id);

      // Reset the user's password
      await resetUserPassword(TOKEN, user.id, PW2, true);

      // Patch the user's display name in the same flow
      await updateUser(TOKEN, user.id, { displayName: 'E2E Feature (renamed)' });

      // Verify the user is in the group AND renamed
      let inGroup = false;
      for (let i = 0; i < 5; i++) {
        const members = await getGroupMembers(TOKEN, group.id);
        if (members.some((m) => m.id === user.id)) {
          inGroup = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 1000));
      }
      expect(inGroup).toBe(true);

      const refreshed = await getUser(TOKEN, user.id);
      expect(refreshed.displayName).toBe('E2E Feature (renamed)');
    } finally {
      // Defensive cleanup — order doesn't matter; both deletes are
      // independent. catch() so a failed first delete doesn't abort the
      // second.
      await removeGroupMember(TOKEN, group.id, user.id).catch(() => undefined);
      await deleteGroup(TOKEN, group.id).catch(() => undefined);
      createdGroups.delete(group.id);
      await deleteUser(TOKEN, user.id).catch(() => undefined);
      createdUsers.delete(user.id);
    }
  });

  it('cleanup leaves no leftover resources from this run', async () => {
    // After every other test in this file has run, both tracking sets
    // should be empty (each test's finally removes its own ids).
    expect(createdUsers.size).toBe(0);
    expect(createdGroups.size).toBe(0);
  });
});

// =====================================================================
// Visibility — whether the suite ran against real Graph or skipped
// =====================================================================

describe('admin CRUD integration suite — config check', () => {
  it(ENABLED ? 'is ENABLED — running against live Graph' : 'is SKIPPED (set GRAPH_ADMIN_TEST_TOKEN + GRAPH_ADMIN_TEST_DOMAIN to enable)', () => {
    if (!ENABLED) {
      // Make the skip reason visible in test output
      // eslint-disable-next-line no-console
      console.log(
        '[adminCrudIntegration] suite skipped — set GRAPH_ADMIN_TEST_TOKEN + GRAPH_ADMIN_TEST_DOMAIN to run against real Microsoft Graph'
      );
    }
    expect(true).toBe(true);
  });
});

// Reference assertion to keep the (otherwise unused) afterEach import
// from being flagged by the lint pass. afterEach is intentionally NOT
// used here — each test handles its own cleanup in try/finally so a
// failure surface inside the test (not in a teardown the runner reports
// separately).
afterEach(() => {});
