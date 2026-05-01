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
  '- Reply directly and clearly. No hedging, no "based on the context" preamble, no needless apologies.\n' +
  '- Prefer STRUCTURED output over prose: use "## " headings to group topics, bullet lists for enumerations, "**Key:** value" pairs for facts/figures, and tables when comparing items. Avoid long paragraphs — break facts into discrete bullet points.\n' +
  '- Use **bold** for key terms or values. Use short, complete sentences. Never end a clause mid-thought or with a trailing fragment like "kết quả, và ...". Each bullet must be a self-contained, grammatically complete unit.\n' +
  '- Cite each factual claim inline as [Source: <exact title>] using the title shown in the context. The reader uses these markers to locate the citation in the Sources list and open the source.\n' +
  '- Be concise. Aim for the shortest answer that fully addresses the question — typically 4-8 bullets across 2-3 sections. If you find yourself running long, drop redundancy, never truncate.\n\n' +
  'When the context list is EMPTY (no chunks at all) — and only then:\n' +
  '- Reply exactly: "I do not have access to that information." Then stop. Do not speculate or hint at what other groups might see.\n' +
  '- If there is at least one chunk in the context, you MUST answer from it, even if the question is broad ("summarise the policies for this quarter") or short ("company policy"). Synthesise an overview from whatever material is available; do not refuse just because the question is generic.\n\n' +
  'Reply in the same language the user used to ask the question, with the fluency and grammatical accuracy of a native writer in that language.';

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
