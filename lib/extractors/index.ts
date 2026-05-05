import matter from 'gray-matter';
import { humanizeFilename, normalisePdfText } from '@/lib/utils/chunker';

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
    title: fmTitle || humanizeFilename(stripExt(filename)),
    detectedContentType: 'text/markdown'
  };
}

async function extractText(buffer: Buffer, filename: string): Promise<Extracted> {
  return {
    text: decodeUtf8(buffer).trim(),
    title: humanizeFilename(stripExt(filename)),
    detectedContentType: 'text/plain'
  };
}

async function extractHtml(buffer: Buffer, filename: string): Promise<Extracted> {
  const html = decodeUtf8(buffer);
  // Pull <title> if present.
  const titleMatch = /<title[^>]*>([^<]+)<\/title>/i.exec(html);
  const title = titleMatch?.[1]?.trim() || humanizeFilename(stripExt(filename));

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

/**
 * PDF Info.Title is wrong far more often than it's helpful. Many PDF
 * generators leave it set to garbage that has nothing to do with the
 * document content the user named:
 *   - Word's default: "Microsoft Word - <random temp filename>"
 *   - PowerPoint's default: "PowerPoint Presentation"
 *   - Google Docs export: filename of the local copy at export time
 *   - Acrobat "Untitled" / "Untitled-1" / "Untitled.pdf"
 *   - Slide N (auto-generated when title page was a single slide)
 *
 * The user's chosen filename is almost always more meaningful — they
 * picked it deliberately to find the doc later. Only trust Info.Title
 * when it's clearly intentional and adds information beyond the
 * filename. Otherwise the My Documents list shows things like
 * "Microsoft Word - Document1" instead of the user's "Q3 Financial Report".
 */
function isUsefulPdfTitle(rawTitle: string, filename: string): boolean {
  const t = rawTitle.trim();
  if (t.length < 3) return false;
  // Common generator garbage
  if (/^untitled\b/i.test(t)) return false;
  if (/^document\s*\d*$/i.test(t)) return false;
  if (/^microsoft\s+(word|powerpoint|excel|publisher)\b/i.test(t)) return false;
  if (/^powerpoint\s+presentation$/i.test(t)) return false;
  if (/^slide\s*\d*$/i.test(t)) return false;
  if (/^new\s+(document|presentation|workbook)/i.test(t)) return false;
  // Placeholder words PDF generators leave behind. Match with optional
  // surrounding parens / brackets and surrounding whitespace, since
  // generators emit variants like "(anonymous)", "[Unknown]", " None ".
  if (/^[\(\[\s]*(anonymous|unknown|none|null|n\/a|na|empty|temp|temporary)[\)\]\s]*$/i.test(t)) {
    return false;
  }
  // PDF-internal autogen patterns: "PDFCreator", file-id-looking hashes,
  // hex/uuid blobs the generator wrote into the metadata field instead of
  // a real title.
  if (/^[a-f0-9]{8,}$/i.test(t)) return false;
  if (/^[0-9a-f-]{30,}$/i.test(t)) return false;
  // Title is just the filename (with or without extension) — no value over
  // the humanised filename, and the literal filename is uglier.
  const lowerT = t.toLowerCase();
  const lowerName = filename.toLowerCase();
  const lowerStem = stripExt(filename).toLowerCase();
  if (lowerT === lowerName || lowerT === lowerStem) return false;
  return true;
}

/**
 * Detect bold / italic from a pdf.js fontFamily name.
 *
 * pdf.js surfaces the font's actual PostScript name in `fontFamily`
 * (e.g. `Helvetica-Bold`, `TimesNewRoman-BoldItalic`, `Arial,Bold`).
 * Bold and italic are conventionally encoded into the family name, so
 * a regex on that name is enough most of the time. Generic /
 * subsetted names (`g_d0_f1`, `CIDFont+F2`) carry no style hint — we
 * just say "not bold / not italic" and the text comes through plain.
 *
 * False positives are intentionally low: only match clear style words.
 * Better to miss bold than to wrap unrelated text in `**…**`.
 */
function classifyFontStyle(fontFamily: string | undefined): { bold: boolean; italic: boolean } {
  if (!fontFamily) return { bold: false, italic: false };
  const f = fontFamily;
  const bold = /(^|[^a-z])(bold|black|heavy|semibold|demibold)([^a-z]|$)/i.test(f);
  const italic = /(^|[^a-z])(italic|oblique)([^a-z]|$)/i.test(f);
  return { bold, italic };
}

/** Wrap a glyph run with the right Markdown emphasis markers.
 *
 *   bold + italic → ***text***
 *   bold          → **text**
 *   italic        → *text*
 *   none          → text
 *
 * Whitespace at the edges is moved OUTSIDE the markers. Markdown
 * doesn't accept leading/trailing whitespace inside emphasis (` ** ` is
 * treated as literal asterisks), so `"  Bold  "` must become
 * `"  **Bold**  "` not `"**  Bold  **"`. Without this, ReactMarkdown
 * renders the asterisks raw. */
function wrapEmphasis(str: string, bold: boolean, italic: boolean): string {
  if (!str || (!bold && !italic)) return str;
  const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(str);
  if (!m) return str;
  const [, lead, mid, trail] = m;
  if (!mid) return str;
  // ***x*** is GFM's bold+italic; some renderers prefer ** _x_ ** but
  // *** is more compact and ReactMarkdown handles it natively.
  const open = bold && italic ? '***' : bold ? '**' : '*';
  const close = open;
  return `${lead}${open}${mid}${close}${trail}`;
}

/**
 * Reconstruct page text from pdf.js positioning items so the document's
 * line / paragraph structure AND inline styling (bold, italic, headings)
 * survive extraction.
 *
 * `extractText({ mergePages: true })` produces a single flat string —
 * many PDFs come out as one long run of glyphs with no paragraph breaks
 * because the text-stream order doesn't match reading order. It also
 * throws away every typographic cue (font, size, weight) so bold and
 * headings vanish.
 *
 * `extractTextItems` exposes per-item:
 *   - `str` — the glyph run
 *   - `y`   — vertical position (PDF coords; higher = up the page)
 *   - `height` — used to estimate line height for paragraph detection
 *   - `fontSize`, `fontFamily` — style we encode back into Markdown
 *   - `hasEOL` — pdf.js's own line-break hint (set when the source PDF
 *     emitted an explicit line terminator after this item)
 *
 * Strategy:
 *   1. Sort items in reading order (top → bottom, then left → right).
 *      pdf.js doesn't always emit items in reading order — multi-column
 *      PDFs in particular can stream column-by-column inside a single
 *      page, which scrambles paragraphs after a naive concat.
 *   2. Group items into lines by y-coordinate: items within ~half a
 *      line-height of each other are on the same visual line. Within a
 *      line, only emit emphasis markers when the bold/italic state
 *      changes — adjacent same-style items merge into a single
 *      `**phrase**` instead of `**word1** **word2**`.
 *   3. Tag lines whose dominant font size is significantly larger than
 *      the page median as Markdown headings (`#`, `##`, `###`).
 *   4. Detect paragraph breaks by comparing the y-gap between lines to
 *      the median line height: gap > 1.5x line height ⇒ blank line.
 *   5. Join pages with a blank-line break.
 *
 * Output is Markdown — survives chunking (already markdown-aware in
 * sample-docs), is rendered correctly by the SourceModal's ReactMarkdown,
 * and gives Claude clean structural cues at chat time.
 *
 * Conservative on edge cases — if `items` is empty for a page (unusual
 * but possible for image-only pages or extraction failures), return ''.
 */
interface PdfItem {
  str: string;
  y: number;
  height: number;
  hasEOL: boolean;
  fontSize?: number;
  fontFamily?: string;
}

function buildPageTextFromItems(items: PdfItem[]): string {
  if (!items || items.length === 0) return '';

  // Reading order: top of page (high y) first. Items in `sorted` will
  // preserve original left-to-right order within a y-band thanks to
  // V8's stable sort, which is enough for single-column docs and most
  // multi-column ones (where pdf.js usually emits column-by-column
  // anyway, and the y-sort regroups them by column row).
  const sorted = items.slice().sort((a, b) => {
    const dy = b.y - a.y;
    if (Math.abs(dy) > 2) return dy;
    return 0;
  });

  // Group items into lines by y. Each line tracks:
  //   - the items composing it (in order) — needed for per-item style
  //     so we can emit emphasis transitions inside the line
  //   - dominant fontSize (max across items) — drives heading detection
  //   - dominant height — drives paragraph-gap threshold
  type Line = { y: number; height: number; fontSize: number; items: PdfItem[] };
  const lines: Line[] = [];
  let current: Line | null = null;

  for (const it of sorted) {
    const s = it.str;
    const isEmpty = !s;
    if (isEmpty) {
      // Some PDFs emit empty `str` items just to mark hasEOL; honour
      // the EOL by closing the current line.
      if (it.hasEOL && current) {
        lines.push(current);
        current = null;
      }
      continue;
    }
    if (current && Math.abs(it.y - current.y) <= Math.max(2, current.height * 0.5)) {
      current.items.push(it);
      // Track the dominant height/fontSize on the line so paragraph and
      // heading detection use the line's most-prominent text (avoids
      // mistaking footnote-ref superscripts as the line's typography).
      if (it.height > current.height) current.height = it.height;
      const fs = it.fontSize || it.height || 0;
      if (fs > current.fontSize) current.fontSize = fs;
    } else {
      if (current) lines.push(current);
      current = {
        y: it.y,
        height: it.height || 10,
        fontSize: it.fontSize || it.height || 10,
        items: [it]
      };
    }
    if (it.hasEOL && current) {
      lines.push(current);
      current = null;
    }
  }
  if (current) lines.push(current);
  if (lines.length === 0) return '';

  // Medians for paragraph-gap and heading-size thresholds. Pulled
  // separately because heading detection cares about fontSize while
  // paragraph detection cares about line height (close but not
  // identical — leading can differ from glyph height).
  const heights = lines.map((l) => l.height).sort((a, b) => a - b);
  const medianHeight = heights[Math.floor(heights.length / 2)] || 10;
  const paragraphGap = medianHeight * 1.5;
  const fontSizes = lines.map((l) => l.fontSize).sort((a, b) => a - b);
  const medianFontSize = fontSizes[Math.floor(fontSizes.length / 2)] || 10;

  /** Map a line's dominant font size to a Markdown heading level. None
   *  for body text. Heuristic — generous on the threshold so we don't
   *  mark large body text on a tiny doc as headings. */
  const headingPrefix = (lineFs: number): string => {
    if (lineFs >= medianFontSize * 1.8) return '# ';
    if (lineFs >= medianFontSize * 1.4) return '## ';
    if (lineFs >= medianFontSize * 1.2) return '### ';
    return '';
  };

  /** Render a line: stitch items left-to-right and only emit emphasis
   *  markers at style transitions, so `**foo bar**` stays one phrase
   *  even when pdf.js splits it across two items. */
  const renderLine = (line: Line): string => {
    let out = '';
    let openBold = false;
    let openItalic = false;
    let prevEndedWithSpace = true;
    for (const it of line.items) {
      const s = it.str;
      if (!s) continue;
      const { bold, italic } = classifyFontStyle(it.fontFamily);
      // Close any markers whose state is going off
      if (openItalic && !italic) {
        out += '*';
        openItalic = false;
      }
      if (openBold && !bold) {
        out += '**';
        openBold = false;
      }
      // Insert a space if needed so adjacent items don't glue together
      // when the previous one ended on a non-whitespace char.
      const startsWithSpace = /^\s/.test(s);
      if (!prevEndedWithSpace && !startsWithSpace) out += ' ';
      // Open new markers as needed
      if (bold && !openBold) {
        out += '**';
        openBold = true;
      }
      if (italic && !openItalic) {
        out += '*';
        openItalic = true;
      }
      out += s;
      prevEndedWithSpace = /\s$/.test(s);
    }
    // Close anything still open at end of line.
    if (openItalic) out += '*';
    if (openBold) out += '**';
    return out.trim();
  };

  // Stitch lines back together, applying heading prefixes where the
  // line's font size is significantly larger than the page median.
  // Headings get a paragraph break even if the y-gap is small (visually
  // they're distinct from body text and a Markdown heading on its own
  // line is the rendering convention).
  const renderedLines = lines.map((l) => {
    const body = renderLine(l);
    if (!body) return '';
    const prefix = headingPrefix(l.fontSize);
    return prefix ? `${prefix}${body}` : body;
  });

  let result = renderedLines[0] || '';
  for (let i = 1; i < lines.length; i++) {
    const cur = renderedLines[i];
    if (!cur) continue;
    if (!result) {
      result = cur;
      continue;
    }
    const gap = lines[i - 1].y - lines[i].y;
    const isCurHeading = !!headingPrefix(lines[i].fontSize);
    const isPrevHeading = !!headingPrefix(lines[i - 1].fontSize);
    const blank = gap > paragraphGap || isCurHeading || isPrevHeading;
    result += blank ? '\n\n' : '\n';
    result += cur;
  }
  return result;
}

async function extractPdf(buffer: Buffer, filename: string): Promise<Extracted> {
  // Use `unpdf` (modern pdf.js wrapper, zero native deps, works in
  // Next.js / serverless / Edge). Replaces `pdf-parse`, which wraps an
  // ancient pdf.js v1.10.100 that throws "bad XRef entry" on PDFs
  // produced by current Word / Google Docs / Acrobat — anything using
  // newer cross-reference table formats (most modern PDFs).
  //
  // Dynamic import keeps unpdf out of the cold-start path for routes
  // that never see a PDF.
  const { getDocumentProxy, extractTextItems, extractText } = await import('unpdf');
  const pdf = await getDocumentProxy(new Uint8Array(buffer));

  // Layout-aware extraction first — preserves line and paragraph breaks
  // by working from per-item positioning. Falls back to the flat
  // `extractText({ mergePages: true })` path if positioning isn't
  // available (e.g. exotic PDFs where extractTextItems throws).
  let pageStrings: string[] = [];
  try {
    const { items } = await extractTextItems(pdf);
    pageStrings = items.map((pageItems) => buildPageTextFromItems(pageItems));
  } catch {
    const { text } = await extractText(pdf, { mergePages: false });
    pageStrings = Array.isArray(text) ? text : [String(text || '')];
  }
  // If the layout pass produced nothing usable (e.g. all pages came back
  // empty because positioning data was missing), fall back to the flat
  // path so we at least return SOMETHING.
  if (pageStrings.every((p) => !p.trim())) {
    const { text } = await extractText(pdf, { mergePages: false });
    pageStrings = Array.isArray(text) ? text : [String(text || '')];
  }
  // Page break = blank line. Cheap, readable, and chunker treats blank
  // lines as paragraph boundaries so this also gives the chunker
  // natural cut points between pages.
  const text = pageStrings.map((p) => p.trim()).filter(Boolean).join('\n\n');

  // Default to the user's filename — they picked it on purpose. Try
  // Info.Title only as an enrichment, and reject obvious generator
  // garbage (see isUsefulPdfTitle for why this matters).
  let title = humanizeFilename(stripExt(filename));
  try {
    const meta = await pdf.getMetadata();
    const infoTitle = (meta?.info as Record<string, unknown> | undefined)?.Title;
    if (typeof infoTitle === 'string' && isUsefulPdfTitle(infoTitle, filename)) {
      title = infoTitle.trim();
    }
  } catch {
    // metadata read is best-effort; humanised filename is a fine fallback
  }

  // Final cleanup pass — strip control bytes and collapse 3+ newline
  // runs. normalisePdfText keeps single + double newlines (line + paragraph
  // breaks) so the layout we just rebuilt survives.
  const cleaned = normalisePdfText(text);

  return {
    text: cleaned,
    title,
    detectedContentType: 'application/pdf'
  };
}

async function extractDocx(buffer: Buffer, filename: string): Promise<Extracted> {
  const mod = (await import('mammoth')) as typeof import('mammoth');
  const result = await mod.extractRawText({ buffer });
  return {
    text: (result.value || '').trim(),
    title: humanizeFilename(stripExt(filename)),
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
