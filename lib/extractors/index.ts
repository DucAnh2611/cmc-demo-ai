import matter from 'gray-matter';

export interface Extracted {
  text: string;
  title: string;
  /** Normalised content type the extractor recognised. */
  detectedContentType: string;
}

export interface UnsupportedFile {
  reason: string;
}

/** Allowlist enforced at the API layer. Anything not here → 415 from /api/upload. */
export const ALLOWED_CONTENT_TYPES = [
  'text/markdown',
  'text/plain',
  'text/html',
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
] as const;

export const ALLOWED_EXTENSIONS = ['.md', '.markdown', '.txt', '.html', '.htm', '.pdf', '.docx'] as const;

/** Best-effort content-type detection from filename when the browser sent
 * `application/octet-stream`. Returns the explicit type if the browser was
 * already correct. */
export function normaliseContentType(filename: string, headerType: string): string {
  const lower = filename.toLowerCase();
  if (headerType && headerType !== 'application/octet-stream') return headerType;
  if (lower.endsWith('.md') || lower.endsWith('.markdown')) return 'text/markdown';
  if (lower.endsWith('.txt')) return 'text/plain';
  if (lower.endsWith('.html') || lower.endsWith('.htm')) return 'text/html';
  if (lower.endsWith('.pdf')) return 'application/pdf';
  if (lower.endsWith('.docx')) return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  return headerType || 'application/octet-stream';
}

export function isSupported(contentType: string): boolean {
  return (ALLOWED_CONTENT_TYPES as readonly string[]).includes(contentType);
}

function stripExt(filename: string): string {
  return filename.replace(/\.[^.]+$/, '');
}

function decodeUtf8(buffer: Buffer): string {
  // Strip BOM if present
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return buffer.slice(3).toString('utf8');
  }
  return buffer.toString('utf8');
}

async function extractMarkdown(buffer: Buffer, filename: string): Promise<Extracted> {
  const raw = decodeUtf8(buffer);
  const parsed = matter(raw);
  const fmTitle = (parsed.data?.title as string | undefined) || undefined;
  return {
    text: (parsed.content || raw).trim(),
    title: fmTitle || stripExt(filename),
    detectedContentType: 'text/markdown'
  };
}

async function extractText(buffer: Buffer, filename: string): Promise<Extracted> {
  return {
    text: decodeUtf8(buffer).trim(),
    title: stripExt(filename),
    detectedContentType: 'text/plain'
  };
}

async function extractHtml(buffer: Buffer, filename: string): Promise<Extracted> {
  const html = decodeUtf8(buffer);
  // Pull <title> if present.
  const titleMatch = /<title[^>]*>([^<]+)<\/title>/i.exec(html);
  const title = titleMatch?.[1]?.trim() || stripExt(filename);

  // Strip script/style + tags + collapse whitespace.
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<\/(p|div|li|h[1-6]|br|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/ /g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return { text, title, detectedContentType: 'text/html' };
}

async function extractPdf(buffer: Buffer, filename: string): Promise<Extracted> {
  // Dynamic import — pdf-parse loads fixtures at module-init that fail under
  // some bundlers. Lazy-loading avoids that pitfall.
  const mod = (await import('pdf-parse')) as { default: (data: Buffer) => Promise<{ text: string; info?: Record<string, unknown> }> };
  const pdfParse = mod.default;
  const result = await pdfParse(buffer);
  const fmTitle = result.info?.Title;
  const title = (typeof fmTitle === 'string' && fmTitle.trim()) || stripExt(filename);
  return {
    text: (result.text || '').trim(),
    title,
    detectedContentType: 'application/pdf'
  };
}

async function extractDocx(buffer: Buffer, filename: string): Promise<Extracted> {
  const mod = (await import('mammoth')) as typeof import('mammoth');
  const result = await mod.extractRawText({ buffer });
  return {
    text: (result.value || '').trim(),
    title: stripExt(filename),
    detectedContentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  };
}

/** Dispatch to the right extractor. Throws for unsupported types — callers
 * should `isSupported(contentType)` first or wrap in try/catch. */
export async function extract(
  buffer: Buffer,
  filename: string,
  rawContentType: string
): Promise<Extracted> {
  const ct = normaliseContentType(filename, rawContentType);
  if (!isSupported(ct)) {
    throw new Error(`Unsupported content type: ${ct}`);
  }
  switch (ct) {
    case 'text/markdown':
      return extractMarkdown(buffer, filename);
    case 'text/plain':
      return extractText(buffer, filename);
    case 'text/html':
      return extractHtml(buffer, filename);
    case 'application/pdf':
      return extractPdf(buffer, filename);
    case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
      return extractDocx(buffer, filename);
    default:
      throw new Error(`Unhandled content type: ${ct}`);
  }
}
