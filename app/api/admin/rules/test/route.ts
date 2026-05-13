import '@/lib/envGuard';
import { NextRequest } from 'next/server';
import { checkAdmin } from '@/lib/admin/requireAdmin';
import { validateRuleDraft, compileRule, type SensitivityRule } from '@/lib/security/rules';
import { redactText } from '@/lib/security/redactor';
import {
  buildSensitivityPreamble,
  getAnthropicClient,
  CLAUDE_MODEL,
  isAnthropicConfigured
} from '@/lib/claude/client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/admin/rules/test
 *
 * Body:
 *   { rule: { label, phrases, groups?, enabled? }, sampleText: string }
 *
 * Two-stage preview:
 *
 *   1. SEMANTIC — Claude rewrites the sample with the sensitivity
 *      preamble in play. Phrases are interpreted as concepts: phrases
 *      "money", "phone" with input "contact alice@example.com · $95,000
 *      bonus" yields "contact [REDACTED] · [REDACTED] [REDACTED]".
 *
 *   2. CONVERT — `[REDACTED]` tokens become `«b:preview:6»` blur
 *      markers the UI renders as CSS-blurred bars.
 *
 * Fallback when Claude isn't configured: regex pass on the literal
 * phrases only. No semantic awareness; admin sees the limitation.
 *
 * No side effects — the rule isn't persisted.
 */
export async function POST(req: NextRequest) {
  const auth = await checkAdmin(req);
  if (!auth.ok) return new Response(auth.message, { status: auth.status });

  let body: { rule?: Partial<SensitivityRule>; sampleText?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return new Response('Body must be valid JSON', { status: 400 });
  }

  const sampleText = String(body.sampleText || '');
  if (!body.rule) return new Response('rule is required', { status: 400 });

  const cleanPhrases = Array.isArray(body.rule.phrases)
    ? Array.from(
        new Set(
          body.rule.phrases
            .map((p: unknown) => (typeof p === 'string' ? p.trim() : ''))
            .filter((p: string) => p.length > 0)
        )
      )
    : [];
  const draft: SensitivityRule = {
    id: 'preview',
    label: body.rule.label || 'preview',
    phrases: cleanPhrases,
    groups: Array.isArray(body.rule.groups) ? body.rule.groups : [],
    enabled: body.rule.enabled !== false,
    createdBy: 'preview',
    createdAt: '',
    updatedAt: ''
  };
  const v = validateRuleDraft(draft);
  if (!v.ok) return new Response(v.message, { status: 400 });

  const compiled = compileRule(draft);

  let semanticRendered: string | null = null;
  let semanticAttempted = false;
  let semanticError: string | null = null;

  if (isAnthropicConfigured() && sampleText.length > 0) {
    semanticAttempted = true;
    try {
      const anthropic = getAnthropicClient();
      const preamble = buildSensitivityPreamble([
        { label: draft.label, phrases: cleanPhrases }
      ]);
      const systemPrompt =
        preamble +
        'You are a sensitivity-redactor utility. Output the user-provided text VERBATIM, ' +
        'except where the SENSITIVITY RULES above apply: replace each matching concept ' +
        '(and semantically related values, synonyms, sub-topics, proper nouns) with the ' +
        'literal token [REDACTED]. Preserve all other characters, line breaks, and ' +
        'punctuation exactly. Do not add commentary or wrap your output in quotes.';
      const msg = await anthropic.messages.create({
        model: CLAUDE_MODEL,
        max_tokens: 1024,
        temperature: 0,
        system: systemPrompt,
        messages: [{ role: 'user', content: `Input text:\n\n${sampleText}` }]
      });
      const block = msg.content.find((c) => c.type === 'text');
      semanticRendered = block && block.type === 'text' ? block.text.trim() : '';
    } catch (e) {
      semanticError = (e as Error).message;
    }
  }

  // Final output: convert [REDACTED] tokens (from Claude) into blur
  // markers, OR run the literal regex pass (fallback when Claude isn't
  // configured / errored).
  let rendered: string;
  if (semanticAttempted && !semanticError && semanticRendered !== null) {
    rendered = semanticRendered.replace(/\[REDACTED\]/g, '«b:preview:6»');
  } else {
    const r = redactText(sampleText, [{ rule: compiled, level: 'blur' }]);
    rendered = r.text;
  }

  return Response.json({
    rendered,
    semanticRendered,
    semanticAttempted,
    semanticError,
    explanation: semanticAttempted
      ? 'Claude replaced the concept and related values with [REDACTED]; those tokens render as the blurred bars below.'
      : 'Regex pass only (Claude not configured). Literal phrase matches become blurred bars; semantically related concepts are NOT caught.'
  });
}
