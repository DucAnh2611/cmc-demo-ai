import '@/lib/envGuard'; // first import — throws if a sensitive env var is mis-prefixed with NEXT_PUBLIC_
import { NextRequest } from 'next/server';
import { verifyAccessToken } from '@/lib/auth/verifyToken';
import { getUserGroups } from '@/lib/auth/getUserGroups';
import { secureSearch, type RetrievedChunk } from '@/lib/search/secureSearch';
import {
  getAnthropicClient,
  CLAUDE_MODEL,
  buildSystemPrompt,
  buildUserMessage,
  isAnthropicConfigured
} from '@/lib/claude/client';
import { expandQuery } from '@/lib/claude/expandQuery';
import { sanitizeHistory } from '@/lib/chat/sanitizeHistory';
import { auditLog } from '@/lib/audit/logger';
import { svcLog } from '@/lib/devLog';
import { isAppAdmin } from '@/lib/admin/isAppAdmin';
import { loadRules } from '@/lib/security/rules';
import { resolveAll } from '@/lib/security/resolveLevel';
import { SemanticBlurStream, redactText } from '@/lib/security/redactor';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Synthetic streamed response used when the Anthropic API is unreachable
 * (no key configured, network error, rate limit). Lets us validate the rest
 * of the pipeline — auth → groups → secureSearch → ACL filter → citations —
 * even without Claude. Streams in 80-char pieces so the UI still feels live.
 *
 * `sendToken` is the redactor-wrapped emit function from the route handler:
 * passing chunks of the fallback text through it ensures the sensitive-data
 * layer applies here too — important because the fallback includes a
 * preview of each retrieved chunk, which could itself contain sensitive
 * substrings.
 */
async function streamFallback(
  sendToken: (text: string) => void,
  chunks: RetrievedChunk[],
  question: string,
  reason: string
): Promise<void> {
  const departments = Array.from(
    new Set(chunks.map((c) => c.department).filter((d): d is string => !!d))
  );

  const header = [
    `[fallback mode — Claude not called: ${reason}]`,
    '',
    `Question: ${question}`,
    `Authorized chunks (after ACL filter): ${chunks.length}` +
      (departments.length ? ` — departments: ${departments.join(', ')}` : ''),
    ''
  ].join('\n') + '\n';

  const body = chunks.length === 0
    ? '(no chunks returned — the user has no group matching any indexed doc, or the index is empty)\n'
    : chunks
        .map((c, i) => {
          const preview = c.content.replace(/\s+/g, ' ').slice(0, 300);
          const ellipsis = c.content.length > 300 ? '…' : '';
          return `--- ${i + 1}. ${c.title} (${c.department || 'unknown'}) ---\n${preview}${ellipsis}`;
        })
        .join('\n\n') + '\n';

  const fullText = header + body;
  for (let i = 0; i < fullText.length; i += 80) {
    const piece = fullText.slice(i, i + 80);
    sendToken(piece);
    await new Promise((r) => setTimeout(r, 20));
  }
}

export async function POST(req: NextRequest) {
  const auth = req.headers.get('authorization') || '';
  const match = /^Bearer (.+)$/.exec(auth);
  if (!match) {
    return new Response('Missing bearer token', { status: 401 });
  }
  const token = match[1];

  let user;
  try {
    user = await verifyAccessToken(token);
  } catch (e) {
    return new Response(`Invalid token: ${(e as Error).message}`, { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return new Response('Invalid JSON body', { status: 400 });
  }

  // Strict request shape: only `message` and `history` are allowed. Per
  // Prompt 4 of the demo guide, the backend MUST derive groups from the
  // user's token via Microsoft Graph — never trust group/ACL fields supplied
  // by the client. `history` is permitted because it's just the user's own
  // prior turns echoed back; it cannot bypass ACL (retrieval still uses the
  // server-derived groups for the NEW turn only).
  if (!body || typeof body !== 'object') {
    return new Response('Body must be a JSON object', { status: 400 });
  }
  const ALLOWED_KEYS = new Set(['message', 'history']);
  const extras = Object.keys(body as Record<string, unknown>).filter((k) => !ALLOWED_KEYS.has(k));
  if (extras.length > 0) {
    return new Response(
      `Unexpected field(s) in body: ${extras.join(', ')}. ` +
        'Groups / ACL come from the bearer token via Microsoft Graph, not the client.',
      { status: 400 }
    );
  }

  const message = (((body as { message?: unknown }).message as string) || '').trim();
  if (!message) return new Response('Missing message', { status: 400 });

  // Sanitise client-supplied conversation history. See lib/chat/sanitizeHistory
  // for the rules (shape filter, length cap, Anthropic alternation, trailing
  // user drop). Backend stays stateless — history is never re-embedded or
  // used for retrieval; only the new `message` drives ACL-filtered search.
  const MAX_HISTORY_TURNS = 8;
  const MAX_TURN_CHARS = 8000;
  const sanitised = sanitizeHistory((body as { history?: unknown }).history, {
    maxTurns: MAX_HISTORY_TURNS,
    maxTurnChars: MAX_TURN_CHARS
  });
  if (sanitised.error) {
    return new Response(sanitised.error, { status: 400 });
  }
  const history = sanitised.history;

  // Cache key intentionally derived from the access token (default behavior),
  // not from user.oid. A re-login produces a new token, which busts the cache
  // and re-fetches groups from Graph — required for Scenario E (Section 7.6).
  const groups = await getUserGroups(token);

  // App admins bypass the ACL filter — they're a tenant-wide super-
  // reader role on top of doing user/group management. See
  // lib/admin/isAppAdmin for the gate. Non-admin users get the normal
  // group-intersection filter applied by secureSearch.
  const admin = isAppAdmin(groups);

  // Query expansion → hybrid search per variant → merge by chunk id.
  //
  // We ask Haiku for ≤2 paraphrases (e.g. "compensation policy" →
  // "salary structure", "pay guidelines"), then search all variants in
  // parallel using hybrid retrieval (BM25 + vector). Hits are merged by id
  // keeping the highest score, then we take the top-5 overall. This boosts
  // recall on synonym/phrasing variations without trusting the LLM to pick
  // documents — every search leg goes through Azure's ACL filter, and the
  // post-merge defense-in-depth check below re-validates allowedGroups.
  const variants = await expandQuery(message);
  const perVariantResults = await Promise.all(
    variants.map((v) => secureSearch(v, groups, { top: 5, bypassAcl: admin }))
  );
  const mergedById = new Map<string, RetrievedChunk>();
  for (const results of perVariantResults) {
    for (const c of results) {
      const existing = mergedById.get(c.id);
      if (!existing || (c.score ?? 0) > (existing.score ?? 0)) {
        mergedById.set(c.id, c);
      }
    }
  }
  const allChunks = Array.from(mergedById.values())
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    .slice(0, 5);

  console.log('[chat] retrieval summary', {
    userOid: user.oid,
    originalQuery: message,
    historyTurns: history.length,
    variantCount: variants.length,
    perVariantCounts: perVariantResults.map((r) => r.length),
    mergedUniqueIds: mergedById.size,
    topChunkCount: allChunks.length,
    topChunkTitles: allChunks.map((c) => c.title),
    topChunkScores: allChunks.map((c) => c.score)
  });

  // Defense-in-depth: re-verify each chunk's allowedGroups against the
  // user's groups before doing anything else with the chunk. The Azure AI
  // Search filter already enforced this — this second check would only
  // ever drop a chunk if a future bug in filter construction or an SDK
  // change leaked an unauthorized chunk into the result set. If that ever
  // happens, log loudly so it surfaces in audit and stop the bad chunk
  // from reaching Claude or the citations payload.
  //
  // Admin path bypasses this — admins see EVERY doc by design. Without
  // the bypass, every chunk would fail the per-group intersection check
  // and the admin would see nothing.
  const userGroupSet = new Set(groups);
  const aclVerified = admin
    ? allChunks
    : allChunks.filter((c) => {
        const ok = !!c.allowedGroups && c.allowedGroups.some((g) => userGroupSet.has(g));
        if (!ok) {
          console.error('[acl] chunk failed final-mile ACL check — dropping', {
            chunkId: c.id,
            chunkAllowedGroups: c.allowedGroups,
            userOid: user.oid
          });
        }
        return ok;
      });

  // Sensitive-data layer — admin-configured concepts to blur in chat
  // output. Each rule has a phrase list + optional group filter. A rule
  // applies (level = "blur") when:
  //   - caller is not an admin (admins always bypass), AND
  //   - the rule's groups list is empty (= applies to everyone), OR
  //     caller is a member of at least one of the listed groups.
  // For active rules, Claude is told to redact the concept and
  // semantically related content with the literal token [REDACTED];
  // the SemanticBlurStream below converts those into blur markers
  // the client renders as CSS-blurred bars.
  const sensitivityRules = await loadRules().catch((e) => {
    console.warn('[chat] sensitivity rule load failed — proceeding with no rules', {
      error: (e as Error).message
    });
    return [];
  });
  const resolved = resolveAll(sensitivityRules, {
    oid: user.oid,
    groupIds: groups,
    isAdmin: admin
  });
  console.log('[chat] sensitivity context', {
    userOid: user.oid,
    upn: user.upn,
    isAdmin: admin,
    rulesLoaded: sensitivityRules.length,
    activeRules: resolved.textRules.map((r) => ({
      id: r.rule.id,
      label: r.rule.label,
      phrases: r.rule.phrases,
      scope: r.rule.groups.length === 0 ? 'all-groups' : `${r.rule.groups.length} groups`
    }))
  });
  const chunks = aclVerified;

  const previewParts: string[] = [];
  const encoder = new TextEncoder();

  // One redactor: SemanticBlurStream converts `[REDACTED]` tokens
  // Claude emits per the sensitivity preamble into `«b:id:n»` markers
  // the client renders as blurred bars. `previewParts` keeps the
  // pre-redaction text for the audit log.
  const redactor = new SemanticBlurStream(resolved.textRules);
  // Label map so the client can render a tooltip on each blur span without
  // us repeating the label on every match marker.
  const ruleLabels: Record<string, string> = {};
  for (const { rule } of resolved.textRules) {
    ruleLabels[rule.id] = rule.label;
  }

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };

      // Send the rule label map up front so the client can render
      // tooltips on blur spans as they arrive. Empty object when no
      // text rules apply for this caller — no-op on the client.
      if (Object.keys(ruleLabels).length > 0) {
        send('rules', { labels: ruleLabels });
      }

      const sendToken = (text: string) => {
        previewParts.push(text); // audit captures pre-redaction
        const safe = redactor.push(text);
        if (safe) send('token', { text: safe });
      };

      // Citations are sent AT THE END (in the finally block) after we know
      // which chunks Claude actually referenced. Sending them up-front would
      // surface every retrieved chunk even when the answer only used 2 of 5.

      let usedFallback = false;
      let fallbackReason = '';

      if (!isAnthropicConfigured()) {
        usedFallback = true;
        fallbackReason = 'ANTHROPIC_API_KEY not configured';
      }

      try {
        if (usedFallback) {
          await streamFallback(sendToken, chunks, message, fallbackReason);
        } else {
          const anthropic = getAnthropicClient();
          const userMsg = buildUserMessage(message, chunks);

          // Personalize the system prompt with the logged-in user's display
          // name (from the Entra `name` claim) and the departments visible
          // across the chunks they're authorized to see. The result: Claude
          // addresses them in second person and frames the answer to their
          // scope — e.g. "Alice, your team's compensation review …" instead
          // of a generic "the document states …".
          const visibleDepartments = Array.from(
            new Set(chunks.map((c) => c.department).filter((d): d is string => !!d))
          );
          // Sensitivity hints — pass the active concepts into the prompt
          // so Claude handles them SEMANTICALLY (catches synonyms and
          // related ideas a literal regex would miss: e.g. phrase "pool"
          // also suppresses "swimming", "diving", "water sports").
          const sensitivityHints = resolved.textRules.map(({ rule }) => ({
            label: rule.label,
            phrases: rule.phrases
          }));
          const systemPrompt = buildSystemPrompt({
            name: user.name,
            departments: visibleDepartments,
            sensitivityHints
          });

          // Conversation history (validated above) goes BEFORE the new turn.
          // The new turn is the only one that carries the retrieved RAG
          // context — prior turns are sent as plain text. This keeps the
          // prompt small and ensures retrieval re-runs against current ACL
          // for every turn, not against stale cached chunks.
          const claudeT0 = Date.now();
          const llmStream = await anthropic.messages.stream({
            model: CLAUDE_MODEL,
            // 2048 leaves room for fluent Vietnamese output (which uses ~1.5×
            // more tokens than English for the same content). The system
            // prompt asks Claude to stay concise, so this ceiling is rarely
            // hit; it's here so we don't truncate mid-sentence ("quả, và …")
            // when the answer is naturally long.
            max_tokens: 2048,
            // Lower temperature for deterministic RAG output: two semantically
            // similar questions over the same context should produce the same
            // answer shape. Default 1.0 makes Haiku flip between "summarise"
            // and "refuse" on borderline-vague queries.
            temperature: 0.3,
            system: systemPrompt,
            messages: [
              ...history.map((t) => ({ role: t.role, content: t.content })),
              { role: 'user', content: userMsg }
            ]
          });

          for await (const event of llmStream) {
            if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
              sendToken(event.delta.text);
            }
          }
          const tail = redactor.flush();
          if (tail) send('token', { text: tail });
          // finalMessage() resolves with usage tokens — log after stream ends.
          const final = await llmStream.finalMessage().catch(() => null);
          svcLog({
            service: 'claude',
            op: 'stream',
            details: `${CLAUDE_MODEL} · ${final?.usage?.input_tokens ?? '?'} in / ${final?.usage?.output_tokens ?? '?'} out`,
            ms: Date.now() - claudeT0
          });
        }
        send('done', { fallback: usedFallback });
      } catch (e) {
        // Anthropic call failed mid-flight — discard partial output and
        // stream the fallback instead. The fallback emits raw chunk
        // text without [REDACTED] tokens, so sensitivity rules can't
        // apply on this path. Acceptable for a dev/emergency fallback.
        previewParts.length = 0;
        try {
          await streamFallback(
            sendToken,
            chunks,
            message,
            `Claude API error: ${(e as Error).message}`
          );
          const tail = redactor.flush();
          if (tail) send('token', { text: tail });
          send('done', { fallback: true });
        } catch (e2) {
          send('error', { message: (e2 as Error).message });
        }
      } finally {
        const fullResponse = previewParts.join('');

        // Sources mirror what the answer ON SCREEN actually references.
        // Match each retrieved chunk's title as a substring in the response
        // text. If the answer cites nothing — a refusal, an off-topic
        // reply, a general "what's today's date" — the Sources block stays
        // empty by construction. No brittle refusal-phrase detection
        // needed, no language-specific text matching.
        //
        // Normalisation BEFORE the substring match: lowercase + collapse
        // any run of separators (whitespace, hyphens, underscores, dots,
        // bullets, em/en dashes, quotes) into a single space. Required
        // because uploaded .txt / .docx files without front-matter get
        // titled from the filename (e.g. `town-hall-notes-2026-q1`), but
        // Claude humanises that in the answer text (`Town Hall Notes 2026
        // Q1`). A literal substring match would miss the citation. After
        // normalisation, both forms collapse to `town hall notes 2026 q1`
        // and the match succeeds.
        //
        // Dedupe by title because one source doc is split into N chunks
        // that share a title; without dedupe a single citation match would
        // render N identical rows.
        //
        // Audit log is independent — it still records every chunk that was
        // RETRIEVED (post-ACL filter), regardless of what the UI rendered.
        // Compliance cares about what was pulled from the index, not what
        // the user happened to see in the Sources block.
        const normForMatch = (s: string): string =>
          s
            .toLowerCase()
            .replace(/[\s\-_·.,;:!?'"()\[\]{}—–]+/g, ' ')
            .trim();
        const responseNorm = normForMatch(fullResponse);
        const matchedCitations = chunks.filter((c) => {
          const titleNorm = normForMatch(c.title);
          // Skip degenerate empty titles defensively — would otherwise match
          // every response.
          return titleNorm.length > 0 && responseNorm.includes(titleNorm);
        });
        const seenTitles = new Set<string>();
        const dedupedCitations = matchedCitations.filter((c) => {
          if (seenTitles.has(c.title)) return false;
          seenTitles.add(c.title);
          return true;
        });

        send('citations', {
          chunks: dedupedCitations.map((c) => ({
            id: c.id,
            title: c.title,
            department: c.department,
            sourceUrl: c.sourceUrl
          }))
        });

        // Aggregate redaction stats per request so the audit row stays
        // small. One layer, one level — just count how many blur
        // markers fired and which rules they belonged to.
        const blurCount = redactor.events.length;
        const triggeredRuleIds = Array.from(
          new Set(redactor.events.map((e) => e.ruleId))
        );
        const sensitivitySummary =
          blurCount > 0
            ? ` · sensitivity: blurs=${blurCount}, rules=[${triggeredRuleIds.join(',')}]`
            : '';

        const responsePreview = fullResponse.slice(0, 500) + sensitivitySummary;
        await auditLog({
          userId: user.oid,
          upn: user.upn,
          query: message,
          // Record what was retrieved (post-ACL), not what was displayed.
          retrievedDocIds: chunks.map((c) => c.id),
          retrievedTitles: chunks.map((c) => c.title),
          responsePreview,
          groupCount: groups.length,
          timestamp: new Date().toISOString()
        }).catch(() => {});
        controller.close();
      }
    }
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive'
    }
  });
}
