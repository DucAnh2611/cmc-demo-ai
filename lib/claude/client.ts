import Anthropic from '@anthropic-ai/sdk';

const apiKey = process.env.ANTHROPIC_API_KEY || '';
export const CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-4-6';

let _client: Anthropic | null = null;

export function getAnthropicClient(): Anthropic {
  if (_client) return _client;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY must be set');
  _client = new Anthropic({ apiKey });
  return _client;
}

/**
 * True when an Anthropic API key looks usable. Lets the chat route skip the
 * Claude call (and fall back to a synthetic response) without throwing, so
 * the RAG pipeline — auth, groups, secureSearch, ACL filter — can still be
 * tested end-to-end without LLM access.
 */
export function isAnthropicConfigured(): boolean {
  return apiKey.startsWith('sk-ant-') && apiKey !== 'sk-ant-xxx';
}

// Tuned past the §5.5 verbatim baseline for demo quality:
//   - confident tone, no hedging when the context supports an answer
//   - apologies reserved for "not in context" or upstream errors
//   - Markdown structure for scan-ability and trace-ability via inline
//     [Source: <title>] markers that map to the UI's citation list
//   - same-language reply, written like a fluent native (no truncated
//     phrases, complete grammatical sentences end-to-end)
//   - object-style structure (headings + key-value bullets) instead of long
//     prose paragraphs, so the answer is easy to scan and never depends on
//     the model getting a 4-clause sentence right in a non-English language
export const SYSTEM_PROMPT =
  'You are a confident, precise assistant. Answer ONLY from the provided context.\n\n' +
  'If the context supports an answer:\n' +
  '- Describe and answer based on the documents you can access.\n' +
  '- Reply do not start with word similar to: ["based on", "related to", ...]. Because we need to show to user that user have that permission to know where are they from.\n' +
  '- Reply directly and clearly. No hedging, no "based on the context" preamble, no needless apologies.\n' +
  '- Prefer STRUCTURED output over prose: use "## " headings to group topics, bullet lists for enumerations, "**Key:** value" pairs for facts/figures, and tables when comparing items. Avoid long paragraphs — break facts into discrete bullet points.\n' +
  '- Use **bold** for key terms or values. Use short, complete sentences. Never end a clause mid-thought or with a trailing fragment like "kết quả, và ...". Each bullet must be a self-contained, grammatically complete unit.\n' +
  '- Cite each factual claim inline as [Source: <exact title>] using the title shown in the context. The reader uses these markers to locate the citation in the Sources list and open the source.\n' +
  '- Be concise. Aim for the shortest answer that fully addresses the question — typically 4-8 bullets across 2-3 sections. If you find yourself running long, drop redundancy, never truncate.\n\n' +
  'When the context list is EMPTY (no chunks at all) — and only then:\n' +
  '- Reply exactly: "I do not have access to that information." Then stop. Do not speculate or hint at what other groups might see.\n' +
  '- If there is at least one chunk in the context, you MUST answer from it, even if the question is broad ("summarise the policies for this quarter") or short ("company policy"). Synthesise an overview from whatever material is available; do not refuse just because the question is generic.\n\n' +
  'Reply in the same language the user used to ask the question, with the fluency and grammatical accuracy of a native writer in that language.';

export interface UserContext {
  /** Display name from the Entra token (`name` claim). */
  name?: string;
  /** Distinct department labels visible to this user, derived from the
   * retrieved chunks' `department` field after ACL filtering. */
  departments?: string[];
  /** Sensitivity rules in scope for this user. Each is a phrase list
   *  representing a concept to BLUR — Claude rewrites semantically
   *  related content (synonyms, sub-topics, specific values) with the
   *  literal token `[REDACTED]`. The streaming layer turns those into
   *  visual blur bars. There is one treatment level: blur. */
  sensitivityHints?: Array<{
    label: string;
    phrases: string[];
  }>;
}

/**
 * Personalized system prompt — prepends a short USER preamble to SYSTEM_PROMPT
 * so Claude addresses the logged-in user directly and frames the answer around
 * their authorized scope. Falls back to the base prompt when no name is known.
 */
export function buildSystemPrompt(ctx: UserContext = {}): string {
  const name = (ctx.name || '').trim();
  const sensitivityPreamble = buildSensitivityPreamble(ctx.sensitivityHints || []);
  // Closing reminder — anchors the rules at the END of the prompt
  // so Claude reads them most recently, right before the user message.
  // LLMs weight recent instructions more heavily; the preamble at the
  // top can get overshadowed by the long RAG body in SYSTEM_PROMPT.
  const closingReminder = buildSensitivityClosingReminder(ctx.sensitivityHints || []);
  if (!name) return sensitivityPreamble + SYSTEM_PROMPT + closingReminder;

  const depts = (ctx.departments || [])
    .filter(Boolean)
    .map((d) => d.charAt(0).toUpperCase() + d.slice(1));
  const scopeLine = depts.length
    ? `The context you receive spans these departments: ${depts.join(', ')}. Use whatever is relevant from any of them to answer.`
    : '';

  // The "scoped view" framing anchors the reply in what THIS user can see —
  // not "the company policy" in absolute terms. Two effects:
  //   1. Honest tone — Claude opens with "Based on what you can access …"
  //      rather than implying it knows the full picture.
  //   2. Less overreach — when the user has access to only one department's
  //      docs and asks a broad question, Claude stays within that slice
  //      instead of inventing or hedging about other departments.
  // The same-language rule from SYSTEM_PROMPT still applies, so this opener
  // is rendered in the user's language (e.g. Vietnamese: "Dựa trên các tài
  // liệu bạn có quyền truy cập …").
  const scopedViewLine =
    'Every answer is based ONLY on what this user is currently authorised to view. ' +
    'When the question is broad, open the reply with a short clause that makes the scope explicit ' +
    '(e.g. "Based on the documents you can access, …" — translated to the user\'s language). ' +
    'Never claim or imply knowledge of documents the user cannot see.';

  const preamble =
    `You are answering on behalf of ${name}, who is signed in. ` +
    `Address them in second person where natural ("you", "your team") so the reply feels written for them. ` +
    (scopeLine ? scopeLine + ' ' : '') +
    scopedViewLine +
    '\n\n';

  // Sensitivity preamble at the TOP for primacy, plus a closing
  // reminder at the BOTTOM for recency. Both refer to the same rules.
  // If SYSTEM_PROMPT's "describe and answer" instruction conflicts
  // with redaction, the rules win — stated explicitly in both blocks.
  return sensitivityPreamble + preamble + SYSTEM_PROMPT + closingReminder;
}

/**
 * Short closing reminder appended AFTER the main RAG SYSTEM_PROMPT
 * so the rules are the last thing Claude sees before the user
 * message. This is recency-bias reinforcement — primacy alone (the
 * preamble at the top) gets diluted by the long RAG body.
 */
function buildSensitivityClosingReminder(
  hints: NonNullable<UserContext['sensitivityHints']>
): string {
  if (!hints || hints.length === 0) return '';
  const concepts = hints.map((h) => `"${h.label}"`).join(', ');
  return (
    '\n\n' +
    '════════════════════════════════════════════════════════════════════\n' +
    'FINAL REMINDER — SENSITIVITY RULES OVERRIDE EVERYTHING ABOVE.\n' +
    '════════════════════════════════════════════════════════════════════\n\n' +
    'Active sensitive concepts for this user: ' + concepts + '.\n\n' +
    'Even though the instructions above tell you to "describe and answer based on documents", ' +
    'when the content relates to any concept above you MUST replace specific values, ' +
    'figures, names, or identifiers (and semantically related content — synonyms, ' +
    'sub-topics, examples) with the literal token [REDACTED]. ' +
    'Never quote sensitive content directly from a chunk.'
  );
}

/**
 * Build the prompt section that tells Claude how to handle sensitive
 * concepts SEMANTICALLY — not just as exact-string redaction (the regex
 * layer already does that). The goal: if a rule lists "pool", Claude
 * should also recognise "swimming pool", "diving area", "water sports"
 * etc. as the same concept and redact them — things the regex would miss.
 *
 * The output goes at the TOP of the system prompt so it's the first
 * thing the model reads. We give Claude explicit, distinct instructions
 * per treatment level so it knows whether to omit the concept entirely
 * (redact) or to acknowledge it exists without naming the specific value
 * (blur).
 *
 * Returns empty string when no hints — keeps the default prompt
 * unchanged for chats with no rules in scope.
 */
export function buildSensitivityPreamble(
  hints: NonNullable<UserContext['sensitivityHints']>
): string {
  if (!hints || hints.length === 0) return '';
  const fmtList = hints
    .map((h) => {
      const examples = h.phrases
        .slice(0, 8)
        .map((p) => `"${p}"`)
        .join(', ');
      const overflow = h.phrases.length > 8 ? `, … (${h.phrases.length - 8} more)` : '';
      return `  - ${h.label} — phrases: ${examples}${overflow}`;
    })
    .join('\n');

  return (
    '════════════════════════════════════════════════════════════════════\n' +
    'SENSITIVITY RULES — HIGHEST PRIORITY. Apply BEFORE all other instructions.\n' +
    '════════════════════════════════════════════════════════════════════\n\n' +
    'The following concepts are sensitive for the current user. ' +
    'Recognise them SEMANTICALLY — synonyms, sub-topics, specific values, ' +
    'and proper nouns count as the same concept, not just literal matches.\n\n' +
    fmtList +
    '\n\n' +
    'For each concept above, replace any specific value, identifier, figure, name, ' +
    'or proper noun tied to the concept with the literal token "[REDACTED]" ' +
    '(square brackets, capital letters, no extra characters). Keep generic ' +
    'surrounding context so the answer still reads naturally.\n\n' +
    'Example: phrases "money", "phone" with input "contact alice@example.com · $95,000 bonus" ' +
    '→ "contact [REDACTED] · [REDACTED] [REDACTED]" (replace the email, the dollar amount, AND the related word "bonus").\n\n' +
    'Apply to every sentence of your reply — bullet lists, headings, citations included.\n\n' +
    '════════════════════════════════════════════════════════════════════\n\n'
  );
}

// User message format — verbatim shape from section 5.5:
//   Context:
//   <chunk 1 title>: <content>
//   <chunk 2 title>: <content>
//   ...
//   Question: <user message>
export function buildUserMessage(question: string, chunks: { title: string; content: string }[]): string {
  const ctx = chunks.map((c) => `${c.title}: ${c.content}`).join('\n');
  if (!ctx) {
    return `Context:\n(none — the user has no authorized documents matching this query)\n\nQuestion: ${question}`;
  }
  return `Context:\n${ctx}\n\nQuestion: ${question}`;
}
