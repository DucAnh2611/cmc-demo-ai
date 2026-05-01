import '@/lib/envGuard'; // first import — throws if a sensitive env var is mis-prefixed with NEXT_PUBLIC_
import { NextRequest } from 'next/server';
import { verifyAccessToken } from '@/lib/auth/verifyToken';
import { getUserGroups } from '@/lib/auth/getUserGroups';
import { secureSearch, type RetrievedChunk } from '@/lib/search/secureSearch';
import {
  getAnthropicClient,
  CLAUDE_MODEL,
  SYSTEM_PROMPT,
  buildUserMessage,
  isAnthropicConfigured
} from '@/lib/claude/client';
import { auditLog } from '@/lib/audit/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type SendFn = (event: string, data: unknown) => void;

/**
 * Synthetic streamed response used when the Anthropic API is unreachable
 * (no key configured, network error, rate limit). Lets us validate the rest
 * of the pipeline — auth → groups → secureSearch → ACL filter → citations —
 * even without Claude. Streams in 80-char pieces so the UI still feels live.
 */
async function streamFallback(
  send: SendFn,
  chunks: RetrievedChunk[],
  question: string,
  reason: string,
  previewParts: string[]
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
    previewParts.push(piece);
    send('token', { text: piece });
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

  // Strict request shape: only `message` is allowed. Per Prompt 4 of the
  // demo guide, the backend MUST derive groups from the user's token via
  // Microsoft Graph — never trust group/ACL fields supplied by the client.
  if (!body || typeof body !== 'object') {
    return new Response('Body must be a JSON object', { status: 400 });
  }
  const ALLOWED_KEYS = new Set(['message']);
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

  // Cache key intentionally derived from the access token (default behavior),
  // not from user.oid. A re-login produces a new token, which busts the cache
  // and re-fetches groups from Graph — required for Scenario E (Section 7.6).
  const groups = await getUserGroups(token);
  const allChunks = await secureSearch(message, groups, { top: 5 });

  // Defense-in-depth: re-verify each chunk's allowedGroups against the
  // user's groups before doing anything else with the chunk. The Azure AI
  // Search filter already enforced this — this second check would only
  // ever drop a chunk if a future bug in filter construction or an SDK
  // change leaked an unauthorized chunk into the result set. If that ever
  // happens, log loudly so it surfaces in audit and stop the bad chunk
  // from reaching Claude or the citations payload.
  const userGroupSet = new Set(groups);
  const aclVerified = allChunks.filter((c) => {
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

  // Pass all 5 ACL-verified chunks through — per §5.5 of the demo guide
  // (top 5). The earlier 60%-of-top score filter was tightening citations,
  // but for short / abstract queries it sometimes left only 1-2 chunks and
  // Claude would then refuse with "I do not have access" even though the
  // index had relevant material. Trusting the retrieval ranking gives
  // consistent answers across phrasings of the same question.
  const chunks = aclVerified;

  const previewParts: string[] = [];
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
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
          await streamFallback(send, chunks, message, fallbackReason, previewParts);
        } else {
          const anthropic = getAnthropicClient();
          const userMsg = buildUserMessage(message, chunks);

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
            system: SYSTEM_PROMPT,
            messages: [{ role: 'user', content: userMsg }]
          });

          for await (const event of llmStream) {
            if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
              const text = event.delta.text;
              previewParts.push(text);
              send('token', { text });
            }
          }
        }
        send('done', { fallback: usedFallback });
      } catch (e) {
        // Anthropic call failed mid-flight — discard partial output and
        // stream the fallback instead, so the UI still renders something
        // useful and the demo can continue.
        previewParts.length = 0;
        try {
          await streamFallback(
            send,
            chunks,
            message,
            `Claude API error: ${(e as Error).message}`,
            previewParts
          );
          send('done', { fallback: true });
        } catch (e2) {
          send('error', { message: (e2 as Error).message });
        }
      } finally {
        const fullResponse = previewParts.join('');

        // Filter citations to only chunks whose title appears in the answer
        // text. Substring match is robust enough for our titles (each is a
        // distinctive 3-5 word phrase). Falls back to all retrieved chunks
        // when nothing matches — covers the case where Claude answered
        // without using the [Source: <title>] convention, so the user still
        // sees what was authorized.
        const usedCitations = chunks.filter((c) => fullResponse.includes(c.title));
        const finalCitations = usedCitations.length > 0 ? usedCitations : chunks;

        send('citations', {
          chunks: finalCitations.map((c) => ({
            id: c.id,
            title: c.title,
            department: c.department,
            sourceUrl: c.sourceUrl
          }))
        });

        const responsePreview = fullResponse.slice(0, 500);
        await auditLog({
          userId: user.oid,
          upn: user.upn,
          query: message,
          retrievedDocIds: finalCitations.map((c) => c.id),
          retrievedTitles: finalCitations.map((c) => c.title),
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
