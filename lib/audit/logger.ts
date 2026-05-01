import type { TelemetryClient } from 'applicationinsights';
import { KnownSeverityLevel } from 'applicationinsights';

export interface AuditEvent {
  userId: string;
  upn?: string;
  query: string;
  retrievedDocIds: string[];
  retrievedTitles: string[];
  responsePreview: string;
  groupCount: number;
  timestamp: string;
}

const AUDIT_EVENT = 'rag_query';
const connString = process.env.APPLICATIONINSIGHTS_CONNECTION_STRING;

let _client: TelemetryClient | null = null;
let _initAttempted = false;

async function getClient(): Promise<TelemetryClient | null> {
  if (_client) return _client;
  if (_initAttempted) return null;
  _initAttempted = true;
  if (!connString) return null;

  try {
    const ai = await import('applicationinsights');
    if (!ai.defaultClient) {
      ai.setup(connString)
        .setAutoCollectConsole(false)
        .setAutoCollectExceptions(true)
        .setAutoCollectPerformance(false, false)
        .setAutoCollectRequests(false)
        .setAutoCollectDependencies(false)
        .setSendLiveMetrics(false)
        .start();
    }
    _client = ai.defaultClient;
    return _client;
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[audit] App Insights init failed, falling back to console:', (e as Error).message);
    return null;
  }
}

/**
 * Audit log for RAG queries. Writes to Application Insights `traces` when
 * APPLICATIONINSIGHTS_CONNECTION_STRING is set, and always also writes a
 * structured stdout line for local visibility.
 *
 * Property names match the KQL query in section 7.5 of the demo guide:
 *   traces
 *   | where customDimensions.audit_event == "rag_query"
 *   | project timestamp,
 *             user_oid=customDimensions.user_oid,
 *             query=customDimensions.query,
 *             docs_retrieved=customDimensions.doc_ids
 */
export async function auditLog(event: AuditEvent, severity: KnownSeverityLevel = KnownSeverityLevel.Information): Promise<void> {
  const properties: Record<string, string> = {
    audit_event: AUDIT_EVENT,
    user_oid: event.userId,
    upn: event.upn ?? '',
    query: event.query,
    doc_ids: event.retrievedDocIds.join(','),
    doc_titles: event.retrievedTitles.join(' | '),
    response_preview: event.responsePreview,
    group_count: String(event.groupCount)
  };

  // Always emit a console line — useful for `docker logs`, dev terminal,
  // and as a fallback when App Insights isn't configured.
  // eslint-disable-next-line no-console
  console.log('[audit]', JSON.stringify({ timestamp: event.timestamp, ...properties }));

  const client = await getClient();
  if (!client) return;

  client.trackTrace({
    message: `RAG query by ${event.upn ?? event.userId}`,
    severity,
    properties,
    time: new Date(event.timestamp)
  });
}
