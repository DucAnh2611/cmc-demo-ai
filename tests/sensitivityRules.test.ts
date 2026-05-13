import { describe, it, expect } from 'vitest';
import { resolveLevel, resolveAll } from '@/lib/security/resolveLevel';
import type { CompiledRule } from '@/lib/security/rules';

function mkRule(groups: string[] = []): CompiledRule {
  return {
    id: 'r1',
    label: 'test',
    phrases: ['x'],
    groups,
    enabled: true,
    createdBy: '',
    createdAt: '',
    updatedAt: '',
    regex: /x/g
  };
}

describe('resolveLevel — simplified blur-or-view model', () => {
  it('admin always resolves to view', () => {
    const rule = mkRule(['hr']);
    expect(resolveLevel(rule, { oid: 'a', groupIds: ['hr'], isAdmin: true })).toBe('view');
  });

  it('empty groups → applies to everyone (blur)', () => {
    const rule = mkRule([]);
    expect(resolveLevel(rule, { oid: 'a', groupIds: [], isAdmin: false })).toBe('blur');
    expect(resolveLevel(rule, { oid: 'b', groupIds: ['random'], isAdmin: false })).toBe('blur');
  });

  it('non-empty groups → applies only when caller is in at least one', () => {
    const rule = mkRule(['hr', 'finance']);
    expect(resolveLevel(rule, { oid: 'a', groupIds: ['hr'], isAdmin: false })).toBe('blur');
    expect(resolveLevel(rule, { oid: 'a', groupIds: ['finance'], isAdmin: false })).toBe('blur');
    expect(resolveLevel(rule, { oid: 'a', groupIds: ['public'], isAdmin: false })).toBe('view');
    expect(resolveLevel(rule, { oid: 'a', groupIds: [], isAdmin: false })).toBe('view');
  });
});

describe('resolveAll', () => {
  it('returns only rules that resolve to blur', () => {
    const r1 = mkRule([]); // applies to all
    r1.id = 'r1';
    const r2 = mkRule(['hr']); // applies to HR only
    r2.id = 'r2';
    const r3 = mkRule(['execs']); // doesn't apply to this user
    r3.id = 'r3';
    const result = resolveAll([r1, r2, r3], {
      oid: 'alice',
      groupIds: ['hr', 'public'],
      isAdmin: false
    });
    expect(result.textRules.map((t) => t.rule.id).sort()).toEqual(['r1', 'r2']);
  });

  it('admin context returns no active rules', () => {
    const rules = [mkRule([]), mkRule(['hr'])];
    const result = resolveAll(rules, { oid: 'admin', groupIds: ['hr'], isAdmin: true });
    expect(result.textRules.length).toBe(0);
  });
});
