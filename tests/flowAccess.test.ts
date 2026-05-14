import { describe, it, expect } from 'vitest';
import { checkFlowAccess, type FlowAccessPolicy } from '@/lib/security/flowAccess';

function mk(
  mode: FlowAccessPolicy['mode'],
  allowedGroups: string[] = [],
  allowedUsers: string[] = [],
  linkToken = ''
): FlowAccessPolicy {
  return {
    mode,
    allowedGroups,
    allowedUsers,
    linkToken,
    updatedBy: '',
    updatedAt: ''
  };
}

describe('checkFlowAccess — admin bypass', () => {
  it('admin is granted regardless of mode', () => {
    for (const mode of ['public', 'anyone-with-link', 'restricted'] as const) {
      const d = checkFlowAccess(mk(mode), { isAdmin: true });
      expect(d.granted).toBe(true);
    }
  });

  it('admin is granted in restricted mode with empty lists', () => {
    const d = checkFlowAccess(mk('restricted', [], []), { isAdmin: true });
    expect(d.granted).toBe(true);
  });
});

describe('checkFlowAccess — public mode', () => {
  it('grants unauthenticated visitors', () => {
    const d = checkFlowAccess(mk('public'), {});
    expect(d.granted).toBe(true);
    expect(d.mode).toBe('public');
  });

  it('grants signed-in users', () => {
    const d = checkFlowAccess(mk('public'), { oid: 'alice', groupIds: ['hr'] });
    expect(d.granted).toBe(true);
  });
});

describe('checkFlowAccess — anyone-with-link mode', () => {
  it('denies a plain visit without the share token', () => {
    const d = checkFlowAccess(mk('anyone-with-link', [], [], 'secret-token-123'), {});
    expect(d.granted).toBe(false);
    expect(d.reason).toBe('invalid-link');
  });

  it('denies a wrong share token', () => {
    const d = checkFlowAccess(mk('anyone-with-link', [], [], 'secret-token-123'), {
      shareToken: 'wrong'
    });
    expect(d.granted).toBe(false);
    expect(d.reason).toBe('invalid-link');
  });

  it('grants when the share token matches (unsigned visitor)', () => {
    const d = checkFlowAccess(mk('anyone-with-link', [], [], 'secret-token-123'), {
      shareToken: 'secret-token-123'
    });
    expect(d.granted).toBe(true);
  });

  it('grants when the share token matches (signed-in user)', () => {
    const d = checkFlowAccess(mk('anyone-with-link', [], [], 'secret-token-123'), {
      oid: 'alice',
      shareToken: 'secret-token-123'
    });
    expect(d.granted).toBe(true);
  });

  it('denies when no token is configured on the policy', () => {
    const d = checkFlowAccess(mk('anyone-with-link', [], [], ''), {
      shareToken: 'anything'
    });
    expect(d.granted).toBe(false);
    expect(d.reason).toBe('invalid-link');
  });

  it('admin bypasses regardless of share token', () => {
    const d = checkFlowAccess(mk('anyone-with-link', [], [], 'secret-token-123'), {
      isAdmin: true
    });
    expect(d.granted).toBe(true);
  });
});

describe('checkFlowAccess — restricted mode', () => {
  it('asks an unsigned visitor to sign in', () => {
    const d = checkFlowAccess(mk('restricted', ['hr'], []), {});
    expect(d.granted).toBe(false);
    expect(d.reason).toBe('sign-in-required');
  });

  it('grants a user whose oid is in allowedUsers', () => {
    const d = checkFlowAccess(mk('restricted', [], ['alice-oid']), {
      oid: 'alice-oid',
      groupIds: []
    });
    expect(d.granted).toBe(true);
  });

  it('grants a user who is a member of an allowed group', () => {
    const d = checkFlowAccess(mk('restricted', ['hr'], []), {
      oid: 'alice',
      groupIds: ['hr', 'public']
    });
    expect(d.granted).toBe(true);
  });

  it('denies a signed-in user who matches neither list', () => {
    const d = checkFlowAccess(mk('restricted', ['hr'], ['bob']), {
      oid: 'alice',
      groupIds: ['finance']
    });
    expect(d.granted).toBe(false);
    expect(d.reason).toBe('denied');
  });

  it('reports misconfigured when both allow lists are empty', () => {
    const d = checkFlowAccess(mk('restricted', [], []), {
      oid: 'alice',
      groupIds: ['hr']
    });
    expect(d.granted).toBe(false);
    expect(d.reason).toBe('misconfigured');
  });
});
