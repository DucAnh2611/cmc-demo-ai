import { svcLog } from '@/lib/devLog';

const endpoint = process.env.AZURE_OPENAI_ENDPOINT || '';
const apiKey = process.env.AZURE_OPENAI_API_KEY || '';
const deployment = process.env.AZURE_OPENAI_EMBEDDING_DEPLOYMENT || 'text-embedding-3-small';
const apiVersion = process.env.AZURE_OPENAI_API_VERSION || '2024-02-01';

/**
 * Inputs per embeddings call. Azure OpenAI accepts up to 2048 array items
 * but enforces an 8192-token PER-REQUEST cap (sum across all inputs).
 *
 * Math: chunkText emits ~500-word chunks ≈ ~750 tokens (English) or
 * ~1100 tokens (Vietnamese / token-dense languages). 16 × 1100 ≈ 17.6K —
 * already over. So 8 is the safe ceiling for mixed-language corpora.
 *
 * Trade-off: smaller batches = more sequential round-trips for large
 * uploads (a 10 MB doc with ~2000 chunks → 250 calls @ ~200ms = ~50s
 * total embed time). For demo scale this is fine; production should
 * either parallelise (with a concurrency cap respecting AOAI TPM) or
 * pack inputs by token count instead of by item count.
 */
const MAX_INPUTS_PER_CALL = 8;

interface EmbeddingResponse {
  data: Array<{ embedding: number[]; index: number }>;
  usage?: { prompt_tokens: number; total_tokens: number };
}

export async function embedText(text: string): Promise<number[]> {
  const [vec] = await embedBatch([text]);
  return vec;
}

/**
 * Embed an arbitrary number of input strings. Internally splits into
 * sub-batches of MAX_INPUTS_PER_CALL so a single call never exceeds the
 * Azure OpenAI per-request token cap. Sequential — Azure OpenAI's TPM
 * rate limits make naive parallelism risky for unknown deployment SKUs.
 *
 * Each sub-batch emits one svcLog line so the dev terminal shows progress
 * for long uploads.
 */
export async function embedBatch(inputs: string[]): Promise<number[][]> {
  if (!endpoint || !apiKey) {
    throw new Error('AZURE_OPENAI_ENDPOINT and AZURE_OPENAI_API_KEY must be set');
  }
  if (inputs.length === 0) return [];

  const url = `${endpoint.replace(/\/$/, '')}/openai/deployments/${deployment}/embeddings?api-version=${apiVersion}`;
  const totalBatches = Math.ceil(inputs.length / MAX_INPUTS_PER_CALL);
  const allVectors: number[][] = [];

  for (let i = 0; i < inputs.length; i += MAX_INPUTS_PER_CALL) {
    const slice = inputs.slice(i, i + MAX_INPUTS_PER_CALL);
    const batchIdx = Math.floor(i / MAX_INPUTS_PER_CALL) + 1;
    const t0 = Date.now();
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'api-key': apiKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ input: slice })
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(
        `Azure OpenAI embeddings error ${res.status} (batch ${batchIdx}/${totalBatches}, ${slice.length} input${slice.length === 1 ? '' : 's'}): ${body.slice(0, 300)}`
      );
    }

    const data = (await res.json()) as EmbeddingResponse;
    const vectors = data.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
    allVectors.push(...vectors);

    const batchTag = totalBatches > 1 ? `batch ${batchIdx}/${totalBatches} · ` : '';
    svcLog({
      service: 'aoai',
      op: 'embed',
      details: `${batchTag}${slice.length} input${slice.length === 1 ? '' : 's'} → ${vectors[0]?.length || 0}-dim · ${data.usage?.total_tokens ?? '?'} tok`,
      ms: Date.now() - t0
    });
  }

  return allVectors;
}
