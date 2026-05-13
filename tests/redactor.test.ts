import { describe, it, expect } from 'vitest';
import { redactText, SemanticBlurStream } from '@/lib/security/redactor';
import type { ResolvedRule } from '@/lib/security/resolveLevel';
import { compileRule, type SensitivityRule } from '@/lib/security/rules';

function mkResolved(phrase: string, ruleId = 'r1', label = 'test'): ResolvedRule {
  return {
    rule: {
      id: ruleId,
      label,
      phrases: [phrase],
      groups: [],
      enabled: true,
      createdBy: '',
      createdAt: '',
      updatedAt: '',
      regex: new RegExp(phrase, 'g')
    },
    level: 'blur'
  };
}

describe('redactText — synchronous blur', () => {
  it('passes text through when there are no rules', () => {
    expect(redactText('hello', []).text).toBe('hello');
  });

  it('replaces a single phrase match with a blur marker', () => {
    const r = redactText('Bob earns $95,000.', [mkResolved('\\$\\d[\\d,]*', 'salary', 'Salary')]);
    expect(r.text).toBe('Bob earns «b:salary:7».');
    expect(r.events.length).toBe(1);
    expect(r.events[0].ruleId).toBe('salary');
    expect(r.events[0].matchLength).toBe(7);
  });

  it('handles multiple matches of the same rule', () => {
    const r = redactText('A=$1, B=$2.', [mkResolved('\\$\\d', 'm')]);
    expect(r.text).toBe('A=«b:m:2», B=«b:m:2».');
    expect(r.events.length).toBe(2);
  });

  it('preserves text between matches', () => {
    const r = redactText('start MIDDLE end', [mkResolved('MIDDLE', 'm')]);
    expect(r.text).toBe('start «b:m:6» end');
  });
});

describe('compileRule', () => {
  function mk(phrases: string[]): SensitivityRule {
    return {
      id: 'r',
      label: 't',
      phrases,
      groups: [],
      enabled: true,
      createdBy: '',
      createdAt: '',
      updatedAt: ''
    };
  }

  it('treats each entry as a literal string, escaping regex metachars', () => {
    const compiled = compileRule(mk(['$95,000']));
    expect('Paid $95,000.'.match(compiled.regex)?.[0]).toBe('$95,000');
  });

  it('joins multiple phrases case-insensitively', () => {
    const compiled = compileRule(mk(['Alice', 'BOB']));
    const matches = [...'hi alice, BOB'.matchAll(compiled.regex)].map((m) => m[0]);
    expect(matches.sort()).toEqual(['BOB', 'alice']);
  });

  it('empty phrase list compiles to a regex that never matches', () => {
    const compiled = compileRule(mk([]));
    expect('anything'.match(compiled.regex)).toBeNull();
  });
});

describe('SemanticBlurStream — [REDACTED] → blur marker', () => {
  it('pass-through when no rules are active', () => {
    const s = new SemanticBlurStream([]);
    let out = '';
    out += s.push('hello world');
    out += s.flush();
    expect(out).toBe('hello world');
    expect(s.events.length).toBe(0);
  });

  it('replaces [REDACTED] with a blur marker when a rule is active', () => {
    const s = new SemanticBlurStream([mkResolved('foo', 'salary', 'Salary')]);
    let out = '';
    out += s.push('Bob earns [REDACTED] this year.');
    out += s.flush();
    expect(out).toBe('Bob earns «b:salary:6» this year.');
    expect(s.events.length).toBe(1);
    expect(s.events[0].ruleId).toBe('salary');
  });

  it('catches [REDACTED] split across pushed chunks', () => {
    // Phrase "zzz" doesn't appear in the test text — isolates the
    // [REDACTED]-token replacement pass from the literal-phrase pass.
    const s = new SemanticBlurStream([mkResolved('zzz', 'r1')]);
    let out = '';
    out += s.push('prefix [RED');
    out += s.push('ACTED] suffix');
    out += s.flush();
    expect(out).toBe('prefix «b:r1:6» suffix');
  });

  it('also catches literal phrase matches as defense-in-depth', () => {
    // Even when Claude does not emit [REDACTED], the literal phrase
    // "SECRET" in its output should still be blurred via the regex pass.
    const s = new SemanticBlurStream([mkResolved('SECRET', 'r1', 'Test')]);
    let out = '';
    out += s.push('Bob has a SECRET document and another SECRET note.');
    out += s.flush();
    expect(out).toBe('Bob has a «b:r1:6» document and another «b:r1:6» note.');
  });
});
