import { getUploadsContainer, isBlobConfigured } from '@/lib/storage/blobClient';
import { randomUUID } from 'node:crypto';

/**
 * Sensitive-data rules — admin-configurable phrase lists applied to chat
 * output via a Claude semantic-redactor pass. Simplified model:
 *
 *   - `phrases` is the concept list. Claude treats each phrase as a
 *     concept, not a literal regex, and redacts semantically related
 *     content too (e.g. "money" also covers "salary", "$95,000", "bonus").
 *   - `groups` scopes the rule. When non-empty, only callers who are in
 *     at least one of these groups get the redaction. When empty, the
 *     rule applies to EVERYONE (except admins, who always bypass).
 *
 * There is one treatment level: BLUR. Matched concepts are replaced
 * with a `«b:<ruleId>:6»` marker that the client renders as a CSS-
 * blurred bar. No per-user overrides, no separate redact / deny levels —
 * the previous matrix made the panel hard to reason about and admins
 * preferred a "concepts + audience" model.
 */

/** Single treatment level — present as a type-narrowing constant
 *  rather than a literal because it's referenced by the streaming
 *  redactor's `RedactionEvent` shape. */
export type SensitivityLevel = 'view' | 'blur';

export interface SensitivityRule {
  id: string;
  label: string;
  /** Literal phrases that mark the concept. Claude expands these
   *  semantically at chat time — synonyms, related ideas, values. */
  phrases: string[];
  /** Group IDs the rule applies to. Empty = applies to all groups
   *  (anyone signed in, except admins). */
  groups: string[];
  enabled: boolean;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

interface RuleFile {
  version: number;
  rules: SensitivityRule[];
}

/** Compiled representation for runtime. Same shape as on-disk plus a
 *  precompiled regex used by the fallback (no-Claude) redactor that
 *  only catches literal phrase matches. */
export interface CompiledRule extends SensitivityRule {
  regex: RegExp;
}

const BLOB_NAME = 'rules/sensitivity.json';
const CACHE_TTL_MS = 60_000;
const MAX_PHRASES_PER_RULE = 50;
const MAX_PHRASE_CHARS = 200;

let _cache: { at: number; file: RuleFile; compiled: CompiledRule[] } | null = null;

function escapeRegex(s: string): string {
  return s.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
}

export function validateRuleDraft(
  input: Partial<SensitivityRule>
): { ok: true } | { ok: false; message: string } {
  if (!input.label || typeof input.label !== 'string' || input.label.trim().length < 2) {
    return { ok: false, message: 'label is required (min 2 chars)' };
  }
  if (!Array.isArray(input.phrases) || input.phrases.length === 0) {
    return { ok: false, message: 'phrases must be a non-empty array of strings' };
  }
  if (input.phrases.length > MAX_PHRASES_PER_RULE) {
    return { ok: false, message: `too many phrases (max ${MAX_PHRASES_PER_RULE} per rule)` };
  }
  for (const p of input.phrases) {
    if (typeof p !== 'string' || p.length === 0) {
      return { ok: false, message: 'each phrase must be a non-empty string' };
    }
    if (p.length > MAX_PHRASE_CHARS) {
      return {
        ok: false,
        message: `phrase too long (max ${MAX_PHRASE_CHARS} chars): "${p.slice(0, 40)}…"`
      };
    }
  }
  if (input.groups !== undefined && !Array.isArray(input.groups)) {
    return { ok: false, message: 'groups must be an array of group IDs (or omitted for all groups)' };
  }
  if (Array.isArray(input.groups)) {
    for (const g of input.groups) {
      if (typeof g !== 'string' || g.length === 0) {
        return { ok: false, message: 'each group ID must be a non-empty string' };
      }
    }
  }
  return { ok: true };
}

/** Build a case-insensitive regex from the rule's literal phrases.
 *  Used by the no-Claude fallback path. Longer phrases sort first so
 *  multi-word entries win over their sub-strings on overlap. */
export function compileRule(r: SensitivityRule): CompiledRule {
  const phrases = (r.phrases || [])
    .filter((p) => typeof p === 'string' && p.length > 0)
    .slice()
    .sort((a, b) => b.length - a.length);
  if (phrases.length === 0) return { ...r, regex: /(?!)/g };
  const source = phrases.map(escapeRegex).join('|');
  return { ...r, regex: new RegExp(source, 'gi') };
}

async function readBlobFile(): Promise<RuleFile> {
  if (!isBlobConfigured()) return { version: 0, rules: [] };
  const container = await getUploadsContainer();
  const block = container.getBlockBlobClient(BLOB_NAME);
  if (!(await block.exists())) return { version: 0, rules: [] };
  const buf = await block.downloadToBuffer();
  try {
    const parsed = JSON.parse(buf.toString('utf8')) as RuleFile;
    if (!parsed || !Array.isArray(parsed.rules)) return { version: 0, rules: [] };
    // Migration — older shapes had `patterns` / `defaultLevel` / `overrides`.
    // Reshape into the new minimal model so legacy rules still load.
    parsed.rules = parsed.rules.map((r) => {
      const legacy = r as unknown as {
        patterns?: string[];
        pattern?: string;
        overrides?: Array<{ match: string; level: string }>;
      };
      const next: SensitivityRule = {
        id: r.id,
        label: r.label,
        phrases:
          Array.isArray((r as SensitivityRule).phrases) && (r as SensitivityRule).phrases.length > 0
            ? (r as SensitivityRule).phrases
            : Array.isArray(legacy.patterns)
            ? legacy.patterns
            : legacy.pattern
            ? [legacy.pattern]
            : [],
        groups:
          Array.isArray((r as SensitivityRule).groups)
            ? (r as SensitivityRule).groups
            // Best-effort: extract `group:*` matches from legacy overrides
            // so admins don't have to re-pick scope after the migration.
            : Array.isArray(legacy.overrides)
            ? legacy.overrides
                .filter((o) => typeof o.match === 'string' && o.match.startsWith('group:'))
                .map((o) => o.match.slice('group:'.length))
            : [],
        enabled: r.enabled !== false,
        createdBy: r.createdBy || '',
        createdAt: r.createdAt || '',
        updatedAt: r.updatedAt || ''
      };
      return next;
    });
    return parsed;
  } catch {
    return { version: 0, rules: [] };
  }
}

async function writeBlobFile(file: RuleFile): Promise<void> {
  if (!isBlobConfigured()) {
    throw new Error('Blob storage not configured — cannot persist rules');
  }
  const container = await getUploadsContainer();
  const block = container.getBlockBlobClient(BLOB_NAME);
  const buf = Buffer.from(JSON.stringify(file, null, 2), 'utf8');
  await block.uploadData(buf, {
    blobHTTPHeaders: { blobContentType: 'application/json; charset=utf-8' }
  });
}

export async function loadRules(force = false): Promise<CompiledRule[]> {
  const now = Date.now();
  if (!force && _cache && now - _cache.at < CACHE_TTL_MS) return _cache.compiled;
  const file = await readBlobFile();
  const compiled = file.rules
    .filter((r) => r.enabled !== false)
    .map(compileRule);
  _cache = { at: now, file, compiled };
  return compiled;
}

export function invalidateRulesCache(): void {
  _cache = null;
}

export async function listAllRules(): Promise<SensitivityRule[]> {
  const file = await readBlobFile();
  return file.rules;
}

export async function getRule(id: string): Promise<SensitivityRule | null> {
  const file = await readBlobFile();
  return file.rules.find((r) => r.id === id) || null;
}

export async function createRule(
  input: Omit<SensitivityRule, 'id' | 'createdAt' | 'updatedAt' | 'createdBy'>,
  createdBy: string
): Promise<SensitivityRule> {
  const v = validateRuleDraft(input);
  if (!v.ok) throw new Error(v.message);
  const file = await readBlobFile();
  const now = new Date().toISOString();
  const rule: SensitivityRule = {
    ...input,
    groups: input.groups || [],
    id: randomUUID(),
    createdBy,
    createdAt: now,
    updatedAt: now
  };
  file.rules.push(rule);
  file.version = (file.version || 0) + 1;
  await writeBlobFile(file);
  invalidateRulesCache();
  return rule;
}

export async function updateRule(
  id: string,
  patch: Partial<Omit<SensitivityRule, 'id' | 'createdAt' | 'createdBy'>>
): Promise<SensitivityRule> {
  const file = await readBlobFile();
  const idx = file.rules.findIndex((r) => r.id === id);
  if (idx < 0) throw new Error(`Rule not found: ${id}`);
  const merged: SensitivityRule = {
    ...file.rules[idx],
    ...patch,
    groups: patch.groups !== undefined ? patch.groups : file.rules[idx].groups,
    updatedAt: new Date().toISOString()
  };
  const v = validateRuleDraft(merged);
  if (!v.ok) throw new Error(v.message);
  file.rules[idx] = merged;
  file.version = (file.version || 0) + 1;
  await writeBlobFile(file);
  invalidateRulesCache();
  return merged;
}

export async function deleteRule(id: string): Promise<void> {
  const file = await readBlobFile();
  const before = file.rules.length;
  file.rules = file.rules.filter((r) => r.id !== id);
  if (file.rules.length === before) throw new Error(`Rule not found: ${id}`);
  file.version = (file.version || 0) + 1;
  await writeBlobFile(file);
  invalidateRulesCache();
}
