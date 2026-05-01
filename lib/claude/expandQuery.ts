import { getAnthropicClient, isAnthropicConfigured, CLAUDE_MODEL } from './client';

/**
 * Model used for query rewriting. Defaults to the SAME model as the answer
 * (`CLAUDE_MODEL`) so expansion works whenever chat works — important for
 * non-English queries, where missing expansion silently collapses recall.
 *
 * Override via env if you want a cheaper/faster model just for expansion:
 *   CLAUDE_EXPANSION_MODEL=claude-haiku-4-5-20251001
 *
 * Cost note: paraphrase generation is ~80 input + ~80 output tokens. At
 * Sonnet pricing (~$3/MTok) that's ~$0.0005 per question — negligible.
 */
const EXPANSION_MODEL = process.env.CLAUDE_EXPANSION_MODEL || CLAUDE_MODEL;

/**
 * Hard ceiling on paraphrases requested from Haiku. Two extras + the
 * original = 3 search legs in parallel — covers the common synonym /
 * phrasing miss without ballooning Search QPS or merge cost.
 */
const MAX_VARIANTS = 2;

const EXPANSION_SYSTEM =
  'You rewrite a user question into alternate phrasings to improve document retrieval recall. ' +
  'Reply with ONLY a JSON array of strings — no prose, no markdown, no code fence. ' +
  '\n\n' +
  'Each variant must preserve the original intent exactly — never broaden, narrow, or invent topics. ' +
  'Use different keywords or synonyms (e.g. "compensation" ↔ "salary" ↔ "pay"). ' +
  '\n\n' +
  'LANGUAGE HANDLING — important: the document corpus is primarily in English. ' +
  'If the original question is in English, return ' + MAX_VARIANTS + ' English paraphrases. ' +
  'If the original question is in any other language (Vietnamese, French, Japanese, etc.), return: ' +
  '(1) one same-language paraphrase using different wording, AND ' +
  '(2) one literal English translation of the question. ' +
  'The English translation must be a faithful translation, not a paraphrase. ' +
  'This lets keyword search match the English documents while preserving same-language recall. ' +
  '\n\n' +
  'Do NOT include the original question itself in the array. Return at most ' + MAX_VARIANTS + ' variants.';

/**
 * Generate up to MAX_VARIANTS paraphrases of `question` and return them
 * combined with the original (original first, deduped, trimmed).
 *
 * Guarantees: returns at least `[question]`. Any failure path — no API key,
 * network error, malformed JSON, empty array — falls through silently to
 * single-query mode. The caller does NOT need to handle errors.
 */
export async function expandQuery(question: string): Promise<string[]> {
  const original = question.trim();
  if (!original) return [];
  if (!isAnthropicConfigured()) return [original];

  try {
    const client = getAnthropicClient();
    const resp = await client.messages.create({
      model: EXPANSION_MODEL,
      // 256 is plenty for a JSON array of ≤2 short paraphrases. Keeping it
      // tight bounds latency (Haiku TTFT + ~256 tokens ≈ 250-400 ms).
      max_tokens: 256,
      // Determinism over creativity — we want stable retrieval across runs
      // of the same question, not novel rephrasings each time.
      temperature: 0.2,
      system: EXPANSION_SYSTEM,
      messages: [{ role: 'user', content: original }]
    });

    const text = resp.content
      .map((b) => (b.type === 'text' ? b.text : ''))
      .join('')
      .trim();

    const variants = parseVariants(text);
    const all = dedupe([original, ...variants]).slice(0, MAX_VARIANTS + 1);
    console.log('[expandQuery] variants generated', {
      model: EXPANSION_MODEL,
      original,
      variants: all.slice(1),
      rawCount: variants.length
    });
    return all;
  } catch (e) {
    console.warn('[expandQuery] LLM call failed — falling back to single-query', {
      model: EXPANSION_MODEL,
      original,
      error: (e as Error).message
    });
    return [original];
  }
}

/**
 * Pull a JSON array out of Haiku's reply. Handles the happy path (pure JSON)
 * and the common drift modes (leading prose, ```json fences, trailing
 * commentary). Anything we cannot parse becomes "no variants" rather than an
 * error — query expansion is best-effort.
 */
function parseVariants(text: string): string[] {
  if (!text) return [];

  // Strip Markdown code fences if Haiku wrapped the JSON despite instructions.
  const unfenced = text
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .trim();

  // Locate the outermost [...] — tolerates leading prose like "Here are: [..]".
  const start = unfenced.indexOf('[');
  const end = unfenced.lastIndexOf(']');
  if (start === -1 || end === -1 || end <= start) return [];

  const slice = unfenced.slice(start, end + 1);
  let parsed: unknown;
  try {
    parsed = JSON.parse(slice);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  return parsed
    .filter((v): v is string => typeof v === 'string')
    .map((v) => v.trim())
    .filter((v) => v.length > 0 && v.length < 500);
}

function dedupe(strings: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of strings) {
    const key = s.toLowerCase().replace(/\s+/g, ' ').trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}
