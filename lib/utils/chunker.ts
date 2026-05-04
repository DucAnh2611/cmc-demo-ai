/**
 * Turn a filename stem (typically lowercase with hyphens / underscores)
 * into a Title Case display string. Used as a friendly fallback for the
 * doc title when the underlying extractor can't find a real one (e.g.
 * `.txt` files have no metadata; PDFs often omit Info.Title; .docx
 * uploaded with default Word settings).
 *
 * Rules:
 *   - hyphens and underscores → spaces
 *   - first letter of each word capitalised, rest lowercased
 *   - tokens that look like a quarter label (q1/q2/q3/q4) → Q1/Q2/Q3/Q4
 *   - pure-digit tokens (years, doc numbers) → kept as-is
 *
 * Examples:
 *   `town-hall-notes-2026-q1`  →  `Town Hall Notes 2026 Q1`
 *   `compensation_policy`      →  `Compensation Policy`
 *   `q3-financial-statement`   →  `Q3 Financial Statement`
 */
export function humanizeFilename(name: string): string {
  return name
    .replace(/[-_]+/g, ' ')
    .trim()
    .split(/\s+/)
    .map((w) => {
      if (/^q[1-4]$/i.test(w)) return w.toUpperCase();
      if (/^\d+$/.test(w)) return w;
      return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
    })
    .join(' ');
}

/**
 * Light cleanup for PDF-extracted text. PDF parsers emit raw glyph runs
 * with no awareness of paragraph or whitespace structure; the result
 * often has double spaces, control characters, and per-line trailing
 * whitespace that look broken when displayed in the source modal and
 * waste tokens when sent to the LLM.
 *
 * Conservative: keeps single newlines (line breaks within a paragraph)
 * and double newlines (paragraph break — relied on by the chunker's
 * paragraph-aware splitter).
 *
 *   - Strip control bytes except \t \n
 *   - Normalise CRLF / CR → LF
 *   - Collapse runs of spaces / tabs → single space (preserves newlines)
 *   - Trim trailing whitespace from each line
 *   - Collapse 3+ consecutive newlines → 2 (cap paragraph spacing)
 */
export function normalisePdfText(text: string): string {
  if (!text) return text;
  return text
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Break up runs of non-whitespace longer than `maxTokenChars` by inserting
 * a single space at the boundary. Required before indexing into Azure AI
 * Search whose default Lucene analyzer rejects any single token longer
 * than 128 chars with the cryptic error:
 *
 *   "Command token too long: 128"
 *
 * Common triggers: URLs, base64 blobs, PDF text-extraction artifacts that
 * stitch words together without spaces, table/form data with no
 * whitespace, encoded IDs, hash strings.
 *
 * Default limit is conservatively below the analyzer's 128, leaving margin
 * for diacritics that expand under UTF-8.
 */
export function breakLongTokens(text: string, maxTokenChars = 100): string {
  if (!text) return text;
  // Lookahead `(?=\S)` ensures we only split when the run is genuinely
  // longer than the limit — avoids inserting a trailing space.
  return text.replace(new RegExp(`(\\S{${maxTokenChars}})(?=\\S)`, 'g'), '$1 ');
}

/**
 * Simple word-window chunker. ~500 tokens ≈ ~700 words for Vietnamese/English mix.
 * Splits on paragraph boundaries first, then packs paragraphs into chunks <= maxWords.
 */
export function chunkText(text: string, maxWords = 500, overlapWords = 50): string[] {
  const paragraphs = text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);

  const chunks: string[] = [];
  let buf: string[] = [];
  let bufWordCount = 0;

  const flush = () => {
    if (buf.length === 0) return;
    chunks.push(buf.join('\n\n'));
    if (overlapWords > 0) {
      const tail = buf.join(' ').split(/\s+/).slice(-overlapWords).join(' ');
      buf = tail ? [tail] : [];
      bufWordCount = tail ? tail.split(/\s+/).length : 0;
    } else {
      buf = [];
      bufWordCount = 0;
    }
  };

  for (const p of paragraphs) {
    const words = p.split(/\s+/).length;
    if (bufWordCount + words > maxWords && bufWordCount > 0) {
      flush();
    }
    if (words > maxWords) {
      const tokens = p.split(/\s+/);
      for (let i = 0; i < tokens.length; i += maxWords - overlapWords) {
        chunks.push(tokens.slice(i, i + maxWords).join(' '));
      }
      continue;
    }
    buf.push(p);
    bufWordCount += words;
  }
  flush();
  return chunks;
}
