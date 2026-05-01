/**
 * Sanitises client-supplied conversation history before forwarding to Claude.
 *
 * Why client-supplied: the backend is intentionally stateless (no Redis, no
 * DB, no per-user session cache) — see the chat route's comment on this
 * choice. History is just the user echoing their own prior turns; nothing
 * here can elevate ACL or pull restricted data into context. Retrieval still
 * runs fresh against current Entra groups for every new turn.
 *
 * What this function enforces:
 *   - Shape: each turn must be `{role: 'user' | 'assistant', content: string}`.
 *     Unknown roles, missing content, non-string content → silently dropped.
 *   - Length cap: per-turn `maxTurnChars`, total `maxTurns`. Bounds prompt
 *     size + Anthropic cost. Older turns are trimmed first.
 *   - Anthropic alternation: messages array must alternate user/assistant,
 *     starting with user. Without this, a partially dropped turn can produce
 *     [..., user, user] when the route appends the new user turn — Anthropic
 *     rejects with HTTP 400 ("messages: roles must alternate").
 *   - Trailing assistant: caller appends one new `user` turn, so we drop a
 *     trailing `user` here to keep alternation clean.
 *
 * Returns `{error}` when the top-level shape is invalid (not an array). Any
 * sub-element issue is silently filtered — we don't want a single bad turn
 * to fail the whole request.
 */

export interface HistoryTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface SanitizeOptions {
  maxTurns: number;
  maxTurnChars: number;
}

export interface SanitizeResult {
  history: HistoryTurn[];
  error?: string;
}

export function sanitizeHistory(rawHistory: unknown, opts: SanitizeOptions): SanitizeResult {
  if (rawHistory === undefined || rawHistory === null) {
    return { history: [] };
  }
  if (!Array.isArray(rawHistory)) {
    return { history: [], error: '`history` must be an array' };
  }

  // Step 1 — shape filter. Drop anything that isn't a valid turn.
  let turns: HistoryTurn[] = [];
  for (const item of rawHistory) {
    if (!item || typeof item !== 'object') continue;
    const turn = item as { role?: unknown; content?: unknown };
    if (turn.role !== 'user' && turn.role !== 'assistant') continue;
    const content = typeof turn.content === 'string' ? turn.content.trim() : '';
    if (!content) continue;
    turns.push({
      role: turn.role,
      content:
        content.length > opts.maxTurnChars ? content.slice(0, opts.maxTurnChars) : content
    });
  }

  // Step 2 — cap. Keep the most recent maxTurns entries.
  if (turns.length > opts.maxTurns) {
    turns = turns.slice(turns.length - opts.maxTurns);
  }

  // Step 3 — must start with user. Drop leading orphan assistant turns
  // (can happen after the cap above slices the front).
  while (turns.length > 0 && turns[0].role !== 'user') {
    turns.shift();
  }

  // Step 4 — strict alternation. When two consecutive turns share a role,
  // drop the LATER one (the earlier one is older context the user has
  // already seen on screen, so it's the more semantically grounded turn).
  const alternated: HistoryTurn[] = [];
  for (const t of turns) {
    if (alternated.length === 0 || t.role !== alternated[alternated.length - 1].role) {
      alternated.push(t);
    }
  }

  // Step 5 — caller appends a fresh user turn. If the last surviving turn
  // is also user, drop it to preserve alternation.
  if (alternated.length > 0 && alternated[alternated.length - 1].role === 'user') {
    alternated.pop();
  }

  return { history: alternated };
}
