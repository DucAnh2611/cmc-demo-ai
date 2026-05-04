/**
 * Color-coded service-call log for the dev terminal. The point of this
 * helper is to make it OBVIOUS at a glance — without grepping the JSON
 * audit log — that every Azure / Anthropic service the demo claims to use
 * is actually being invoked per request. Useful when answering "we're
 * billed nothing, are we even using these services?"
 *
 * Each call site emits ONE line per network round-trip. Format:
 *
 *   [hh:mm:ss] {SERVICE TAG}      {operation}  · {details}  · {ms}ms
 *
 * Colors (ANSI escapes — visible in any modern terminal):
 *   - Azure AI Search   → cyan
 *   - Azure OpenAI      → green
 *   - Anthropic Claude  → magenta
 *   - Azure Blob        → yellow
 *   - Microsoft Graph   → blue
 *   - App Insights      → white (dim — least interesting)
 *
 * Toggle with env var DEV_SERVICE_LOG=off to silence (e.g. in CI / prod).
 */

const RESET = '\x1b[0m';
const DIM = '\x1b[2m';

const COLORS = {
  search: '\x1b[36m',
  aoai: '\x1b[32m',
  claude: '\x1b[35m',
  blob: '\x1b[33m',
  graph: '\x1b[34m',
  ai: '\x1b[90m'
};

const LABELS = {
  search: 'Azure AI Search   ',
  aoai:   'Azure OpenAI      ',
  claude: 'Anthropic Claude  ',
  blob:   'Azure Blob        ',
  graph:  'Microsoft Graph   ',
  ai:     'App Insights      '
} as const;

export type ServiceTag = keyof typeof LABELS;

interface ServiceLog {
  service: ServiceTag;
  /** Short verb-ish description: "embed", "hybrid query", "stream", etc. */
  op: string;
  /** Optional context — chunk count, model name, doc size, cache state. */
  details?: string;
  /** Wall-clock duration in ms, when measured. */
  ms?: number;
}

/**
 * Print one colored service-call line to stdout. No-op when
 * DEV_SERVICE_LOG=off.
 */
export function svcLog(log: ServiceLog): void {
  if (process.env.DEV_SERVICE_LOG === 'off') return;
  const ts = new Date().toISOString().slice(11, 19);
  const color = COLORS[log.service];
  const dur = log.ms !== undefined ? ` · ${log.ms}ms` : '';
  const det = log.details ? ` · ${log.details}` : '';
  // eslint-disable-next-line no-console
  console.log(
    `${DIM}[${ts}]${RESET} ${color}${LABELS[log.service]}${RESET}  ${log.op}${det}${dur}`
  );
}

/**
 * Convenience wrapper: time an async operation and log it. Use when you
 * want a single line and don't care about catching errors here.
 *
 *   const result = await timed('search', 'hybrid query', () => client.search(...));
 */
export async function timed<T>(
  service: ServiceTag,
  op: string,
  fn: () => Promise<T>,
  detailsFn?: (result: T) => string
): Promise<T> {
  const t0 = Date.now();
  const result = await fn();
  svcLog({
    service,
    op,
    ms: Date.now() - t0,
    details: detailsFn ? detailsFn(result) : undefined
  });
  return result;
}
