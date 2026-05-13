import type { ResolvedRule } from '@/lib/security/resolveLevel';

/**
 * Blur-only redaction pipeline.
 *
 * The chat path passes each rule into Claude's system prompt as a
 * "concept to blur"; Claude rewrites the answer with the literal token
 * `[REDACTED]` wherever the rule applies — including semantically
 * related content. The streaming pass below converts those tokens into
 * `«b:<ruleId>:6»` markers the client renders as CSS-blurred bars.
 *
 * The fallback path (no Claude key) gets a regex pass that catches
 * literal phrase matches only.
 */

export interface RedactionEvent {
  ruleId: string;
  ruleLabel: string;
  matchLength: number;
}

export interface RedactResult {
  text: string;
  events: RedactionEvent[];
}

function encodeBlur(ruleId: string, length: number): string {
  return `«b:${ruleId}:${length}»`;
}

/** One-shot redactor — used by the source-modal route and the admin
 *  live-test endpoint's no-Claude fallback. Replaces every literal
 *  phrase match with a blur marker sized to the matched length. */
export function redactText(input: string, rules: ResolvedRule[]): RedactResult {
  if (!input || rules.length === 0) return { text: input, events: [] };
  interface Span {
    start: number;
    end: number;
    ruleId: string;
    ruleLabel: string;
  }
  const spans: Span[] = [];
  for (const { rule } of rules) {
    rule.regex.lastIndex = 0;
    for (const m of input.matchAll(rule.regex)) {
      if (m.index === undefined) continue;
      spans.push({
        start: m.index,
        end: m.index + m[0].length,
        ruleId: rule.id,
        ruleLabel: rule.label
      });
    }
  }
  if (spans.length === 0) return { text: input, events: [] };

  spans.sort((a, b) => a.start - b.start || b.end - a.end);

  const events: RedactionEvent[] = [];
  const out: string[] = [];
  let cursor = 0;
  for (const s of spans) {
    if (s.start < cursor) continue;
    if (s.start > cursor) out.push(input.slice(cursor, s.start));
    const len = s.end - s.start;
    out.push(encodeBlur(s.ruleId, len));
    events.push({ ruleId: s.ruleId, ruleLabel: s.ruleLabel, matchLength: len });
    cursor = s.end;
  }
  if (cursor < input.length) out.push(input.slice(cursor));
  return { text: out.join(''), events };
}

/**
 * Streaming redactor used by chat. Per push:
 *
 *   1. Append the new text to the internal buffer.
 *   2. Apply both passes (token replacement + literal phrase regex) to
 *      the entire buffer. Markers from earlier passes are inert — they
 *      don't contain `[REDACTED]` and don't match phrase patterns —
 *      so re-running passes is a no-op for already-redacted spans.
 *   3. Hold back the last `safetyMargin` chars so a phrase or token
 *      straddling the next chunk boundary gets caught next time.
 *   4. Emit the rest immediately.
 *
 * Result: chat streams normally and only the trailing edge is briefly
 * delayed. If nothing in the response matches anything, output is
 * essentially pass-through. If something matches, the user sees a
 * blur bar where the sensitive content would have been.
 */
export class SemanticBlurStream {
  private buffer = '';
  private static readonly BLUR_TOKEN = '[REDACTED]';
  public readonly events: RedactionEvent[] = [];
  private readonly active: boolean;
  private readonly rules: ResolvedRule[];
  private readonly fallbackRuleId: string;
  private readonly fallbackRuleLabel: string;
  /** Hold-back size — large enough that a partial phrase or partial
   *  `[REDACTED]` token at the tail of the buffer can complete in the
   *  next push. = max(longestPhrase, tokenLen) - 1. */
  private readonly safetyMargin: number;

  constructor(textRules: ResolvedRule[]) {
    this.rules = textRules;
    const first = textRules[0];
    this.active = !!first;
    this.fallbackRuleId = first?.rule.id || 'blurred';
    this.fallbackRuleLabel = first?.rule.label || 'sensitive';
    let longest = SemanticBlurStream.BLUR_TOKEN.length;
    for (const { rule } of textRules) {
      for (const p of rule.phrases) {
        if (p.length > longest) longest = p.length;
      }
    }
    this.safetyMargin = Math.max(0, longest - 1);
  }

  push(text: string): string {
    if (!text) return '';
    this.buffer += text;
    if (!this.active) {
      const out = this.buffer;
      this.buffer = '';
      return out;
    }
    // Run both passes on the FULL buffer. Already-emitted text isn't in
    // this.buffer — only what's been retained from prior pushes plus
    // the new chunk. Markers already injected are inert under both
    // passes (no [REDACTED] inside them, no phrase matches).
    const processed = this.applyPasses(this.buffer);
    if (processed.length <= this.safetyMargin) {
      // Not enough text to safely emit anything — hold everything.
      this.buffer = processed;
      return '';
    }
    const safeEnd = processed.length - this.safetyMargin;
    this.buffer = processed.slice(safeEnd);
    return processed.slice(0, safeEnd);
  }

  flush(): string {
    if (!this.buffer) return '';
    if (!this.active) {
      const out = this.buffer;
      this.buffer = '';
      return out;
    }
    // Final pass on whatever's still held back. No need for the safety
    // margin here — the stream is closing, nothing more is coming.
    const out = this.applyPasses(this.buffer);
    this.buffer = '';
    return out;
  }

  /** Token-replace then literal-regex over the input. */
  private applyPasses(text: string): string {
    let out = this.replaceTokens(text);
    const reg = redactText(out, this.rules);
    for (const e of reg.events) this.events.push(e);
    return reg.text;
  }

  private replaceTokens(text: string): string {
    let out = '';
    let i = 0;
    while (i < text.length) {
      const next = text.indexOf(SemanticBlurStream.BLUR_TOKEN, i);
      if (next < 0) {
        out += text.slice(i);
        break;
      }
      out += text.slice(i, next);
      out += encodeBlur(this.fallbackRuleId, 6);
      this.events.push({
        ruleId: this.fallbackRuleId,
        ruleLabel: this.fallbackRuleLabel,
        matchLength: 6
      });
      i = next + SemanticBlurStream.BLUR_TOKEN.length;
    }
    return out;
  }
}
