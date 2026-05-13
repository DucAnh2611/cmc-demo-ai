import type { CompiledRule, SensitivityLevel } from '@/lib/security/rules';

export interface ResolveContext {
  oid: string;
  groupIds: string[];
  isAdmin: boolean;
}

/**
 * Decide whether the rule applies to this caller.
 *
 * Returns:
 *   - `view` — rule is a no-op for this user (admin OR caller is not in
 *     any of the rule's groups when the rule has a group filter)
 *   - `blur` — rule applies; matched concepts get redacted
 *
 * Rules:
 *   1. Admin → always `view` (bypass — same principle as the ACL filter)
 *   2. Rule with empty `groups[]` → applies to everyone (= blur)
 *   3. Rule with non-empty `groups[]` → applies only if the caller is
 *      in at least one of those groups
 */
export function resolveLevel(rule: CompiledRule, ctx: ResolveContext): SensitivityLevel {
  if (ctx.isAdmin) return 'view';
  if (!rule.groups || rule.groups.length === 0) return 'blur';
  const callerGroups = new Set(ctx.groupIds);
  return rule.groups.some((g) => callerGroups.has(g)) ? 'blur' : 'view';
}

export interface ResolvedRule {
  rule: CompiledRule;
  level: SensitivityLevel;
}

/** Resolve every rule for the caller. Returns only the rules where the
 *  level is `blur` — `view`-resolved rules are filtered out (no-op). */
export function resolveAll(rules: CompiledRule[], ctx: ResolveContext): {
  textRules: ResolvedRule[];
} {
  const textRules: ResolvedRule[] = [];
  for (const rule of rules) {
    const level = resolveLevel(rule, ctx);
    if (level === 'blur') textRules.push({ rule, level });
  }
  return { textRules };
}
