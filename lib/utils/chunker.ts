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
