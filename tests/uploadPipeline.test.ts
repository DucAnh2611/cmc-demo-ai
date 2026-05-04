import { describe, it, expect } from 'vitest';
import {
  breakLongTokens,
  chunkText,
  humanizeFilename,
  normalisePdfText
} from '@/lib/utils/chunker';
import {
  ALLOWED_CONTENT_TYPES,
  ALLOWED_EXTENSIONS,
  extract,
  isSupported,
  normaliseContentType
} from '@/lib/extractors';

// All tests below run REAL functions — no mocks of gray-matter, mammoth,
// unpdf, or our own helpers. Each test constructs a real Buffer input
// and asserts on the real return value.
//
// PDF and DOCX live extraction are intentionally NOT covered here:
//   - PDF needs a binary-correct fixture file (the cross-reference table
//     has byte-offset arithmetic that's painful to maintain inline).
//   - DOCX is a zip with multiple parts; same fixture concern.
// For those formats the extractor is a thin wrapper over `unpdf` /
// `mammoth` — verify with a real upload via the dev server. The
// surrounding pipeline (humanise / normalise / chunk / break-long-tokens
// / content-type detection) IS covered, so failures elsewhere will
// surface even when PDF extraction itself isn't tested.

// =====================================================================
// humanizeFilename — title-fallback for files without metadata title
// =====================================================================

describe('humanizeFilename', () => {
  it('converts kebab-case to Title Case', () => {
    expect(humanizeFilename('town-hall-notes')).toBe('Town Hall Notes');
  });

  it('converts snake_case to Title Case', () => {
    expect(humanizeFilename('compensation_policy')).toBe('Compensation Policy');
  });

  it('handles mixed kebab and snake separators', () => {
    expect(humanizeFilename('q3-financial_statement')).toBe('Q3 Financial Statement');
  });

  it('uppercases quarter labels in any case', () => {
    expect(humanizeFilename('q1')).toBe('Q1');
    expect(humanizeFilename('Q2')).toBe('Q2');
    expect(humanizeFilename('budget-q4-review')).toBe('Budget Q4 Review');
  });

  it('preserves pure-digit tokens (years, doc numbers)', () => {
    expect(humanizeFilename('annual-report-2026')).toBe('Annual Report 2026');
    expect(humanizeFilename('memo-001')).toBe('Memo 001');
  });

  it('lowercases the tail of an all-caps token (HOLIDAY → Holiday)', () => {
    expect(humanizeFilename('HOLIDAY-SCHEDULE')).toBe('Holiday Schedule');
  });

  it('collapses runs of separators', () => {
    expect(humanizeFilename('a--b__c')).toBe('A B C');
  });

  it('trims leading/trailing separators', () => {
    expect(humanizeFilename('-leading')).toBe('Leading');
    expect(humanizeFilename('trailing-')).toBe('Trailing');
    expect(humanizeFilename('-both-')).toBe('Both');
  });

  it('returns empty string for empty input', () => {
    expect(humanizeFilename('')).toBe('');
  });

  it('handles a single word', () => {
    expect(humanizeFilename('readme')).toBe('Readme');
  });

  it('preserves whitespace already present (treats as separator)', () => {
    expect(humanizeFilename('hello world')).toBe('Hello World');
  });
});

// =====================================================================
// normalisePdfText — light cleanup on raw PDF text extraction
// =====================================================================

describe('normalisePdfText', () => {
  it('returns empty string for empty input', () => {
    expect(normalisePdfText('')).toBe('');
  });

  it('strips control characters except \\t \\n', () => {
    const dirty = 'hello\x00world\x01\x02';
    expect(normalisePdfText(dirty)).toBe('helloworld');
  });

  it('preserves tabs (collapsed with spaces below) and newlines', () => {
    expect(normalisePdfText('a\tb\nc')).toBe('a b\nc');
  });

  it('normalises CRLF and CR to LF', () => {
    expect(normalisePdfText('a\r\nb\rc')).toBe('a\nb\nc');
  });

  it('collapses runs of spaces and tabs into a single space', () => {
    expect(normalisePdfText('a   b\t\tc')).toBe('a b c');
  });

  it('trims trailing whitespace per line but preserves leading', () => {
    expect(normalisePdfText('hello   \nworld')).toBe('hello\nworld');
  });

  it('preserves single newlines (line breaks within a paragraph)', () => {
    expect(normalisePdfText('line1\nline2\nline3')).toBe('line1\nline2\nline3');
  });

  it('preserves double newlines (paragraph break — chunker depends on this)', () => {
    expect(normalisePdfText('para1\n\npara2')).toBe('para1\n\npara2');
  });

  it('caps 3+ consecutive newlines at 2', () => {
    expect(normalisePdfText('a\n\n\n\n\nb')).toBe('a\n\nb');
  });

  it('trims leading/trailing whitespace from the whole text', () => {
    expect(normalisePdfText('   \n\nhello\n   ')).toBe('hello');
  });

  it('handles a realistic multi-paragraph PDF dump', () => {
    const raw =
      '   Heading text   \r\n' +
      'first    line of body\r\n' +
      'second line of body   \r\n' +
      '\r\n\r\n\r\n' +
      'second paragraph here\x00\x01';
    // Note: the leading 3 spaces on "Heading text" collapse to a single
    // space (multi-space rule), then the final whole-text .trim() strips
    // that single leading space. trimEnd() per line removes the trailing
    // padding. 3+ blank lines collapse to one paragraph break.
    expect(normalisePdfText(raw)).toBe(
      'Heading text\nfirst line of body\nsecond line of body\n\nsecond paragraph here'
    );
  });
});

// =====================================================================
// breakLongTokens — defensive split for Azure AI Search 128-char limit
// =====================================================================

describe('breakLongTokens', () => {
  it('returns input unchanged when no token exceeds the limit', () => {
    const text = 'normal sentence with average length words.';
    expect(breakLongTokens(text, 100)).toBe(text);
  });

  it('returns input unchanged for empty string', () => {
    expect(breakLongTokens('', 100)).toBe('');
  });

  it('inserts ONE space when a token is exactly maxTokenChars + 1', () => {
    const longRun = 'a'.repeat(101);
    const result = breakLongTokens(longRun, 100);
    expect(result).toBe('a'.repeat(100) + ' ' + 'a');
  });

  it('does NOT split a token of exactly maxTokenChars', () => {
    const exact = 'a'.repeat(100);
    expect(breakLongTokens(exact, 100)).toBe(exact);
  });

  it('splits a 250-char run into three pieces of 100/100/50', () => {
    const longRun = 'x'.repeat(250);
    const result = breakLongTokens(longRun, 100);
    expect(result).toBe('x'.repeat(100) + ' ' + 'x'.repeat(100) + ' ' + 'x'.repeat(50));
  });

  it('handles multiple long tokens in the same string', () => {
    const longA = 'a'.repeat(120);
    const longB = 'b'.repeat(120);
    const result = breakLongTokens(`${longA} word ${longB}`, 100);
    expect(result).toBe(
      'a'.repeat(100) + ' ' + 'a'.repeat(20) + ' word ' + 'b'.repeat(100) + ' ' + 'b'.repeat(20)
    );
  });

  it('does not insert a trailing space when long token sits at the end', () => {
    const result = breakLongTokens('start ' + 'z'.repeat(101), 100);
    // "start " + "zzz...100" + " " + "z" — no extra trailing space
    expect(result).toBe('start ' + 'z'.repeat(100) + ' ' + 'z');
    expect(result.endsWith(' ')).toBe(false);
  });

  it('preserves whitespace-separated short tokens around long ones', () => {
    const text = 'before ' + 'q'.repeat(110) + ' after';
    const result = breakLongTokens(text, 100);
    expect(result).toBe('before ' + 'q'.repeat(100) + ' ' + 'q'.repeat(10) + ' after');
  });

  it('treats newlines as whitespace boundaries (does not split across)', () => {
    const text = 'short\n' + 'x'.repeat(105) + '\nshort';
    const result = breakLongTokens(text, 100);
    expect(result).toBe('short\n' + 'x'.repeat(100) + ' ' + 'x'.repeat(5) + '\nshort');
  });

  it('handles unicode (non-ASCII) without breaking chars apart wrongly', () => {
    // ASCII regex `\S` matches non-whitespace including multi-byte unicode.
    // 110 'é' chars = 110 chars logically, but each char is 2 bytes in UTF-8.
    // The regex counts CHARS not bytes, so split happens at 100 chars.
    const longUnicode = 'é'.repeat(110);
    const result = breakLongTokens(longUnicode, 100);
    expect(result).toBe('é'.repeat(100) + ' ' + 'é'.repeat(10));
  });
});

// =====================================================================
// chunkText — paragraph-aware word-window chunker
// =====================================================================

describe('chunkText', () => {
  it('returns an empty array for empty input', () => {
    expect(chunkText('', 500, 50)).toEqual([]);
  });

  it('returns one chunk for short text', () => {
    const out = chunkText('hello world', 500, 50);
    expect(out).toHaveLength(1);
    expect(out[0]).toBe('hello world');
  });

  it('splits on paragraph boundaries (\\n\\n) when total exceeds maxWords', () => {
    const para1 = Array(40).fill('alpha').join(' ');
    const para2 = Array(40).fill('beta').join(' ');
    const out = chunkText(`${para1}\n\n${para2}`, 50, 0);
    expect(out).toHaveLength(2);
    expect(out[0]).toBe(para1);
    expect(out[1]).toBe(para2);
  });

  it('packs multiple short paragraphs into one chunk when they fit', () => {
    const para1 = 'small paragraph one';
    const para2 = 'small paragraph two';
    const out = chunkText(`${para1}\n\n${para2}`, 500, 50);
    expect(out).toHaveLength(1);
    expect(out[0]).toContain(para1);
    expect(out[0]).toContain(para2);
  });

  it('force-splits a single very long paragraph that exceeds maxWords', () => {
    // 120 unique words in ONE paragraph (no \n\n). With maxWords=50 and
    // overlap=0, expect 3 chunks (50, 50, 20).
    const words = Array.from({ length: 120 }, (_, i) => `w${i}`);
    const out = chunkText(words.join(' '), 50, 0);
    expect(out.length).toBeGreaterThan(1);
    expect(out[0].split(/\s+/).length).toBeLessThanOrEqual(50);
  });

  it('produces overlapping content when overlapWords > 0', () => {
    const para1 = Array(40).fill('alpha').join(' ');
    const para2 = Array(40).fill('beta').join(' ');
    const out = chunkText(`${para1}\n\n${para2}`, 50, 10);
    // First chunk fits para1 (40 words). flush() then carries the last
    // 10 words into the buffer for chunk 2. Chunk 2 = 10-word tail of
    // para1 + para2.
    expect(out.length).toBeGreaterThanOrEqual(2);
    expect(out[1].includes('alpha')).toBe(true); // overlap carried
    expect(out[1].includes('beta')).toBe(true);
  });

  it('drops empty paragraphs', () => {
    const out = chunkText('hello\n\n\n\nworld', 500, 50);
    expect(out).toHaveLength(1);
    expect(out[0]).toContain('hello');
    expect(out[0]).toContain('world');
  });

  it('trims whitespace from paragraphs', () => {
    const out = chunkText('   alpha   \n\n   beta   ', 500, 50);
    expect(out[0]).toBe('alpha\n\nbeta');
  });
});

// =====================================================================
// normaliseContentType — browser sometimes sends application/octet-stream
// =====================================================================

describe('normaliseContentType', () => {
  it('respects an explicit, non-octet-stream MIME from the browser', () => {
    expect(normaliseContentType('foo.bin', 'image/png')).toBe('image/png');
  });

  it('treats octet-stream as "browser does not know" and falls back to extension', () => {
    expect(normaliseContentType('doc.pdf', 'application/octet-stream')).toBe('application/pdf');
  });

  it('detects markdown from .md and .markdown extensions', () => {
    expect(normaliseContentType('readme.md', '')).toBe('text/markdown');
    expect(normaliseContentType('readme.markdown', '')).toBe('text/markdown');
  });

  it('detects plain text from .txt', () => {
    expect(normaliseContentType('notes.txt', '')).toBe('text/plain');
  });

  it('detects HTML from .html and .htm', () => {
    expect(normaliseContentType('page.html', '')).toBe('text/html');
    expect(normaliseContentType('page.htm', '')).toBe('text/html');
  });

  it('detects PDF from .pdf', () => {
    expect(normaliseContentType('doc.pdf', '')).toBe('application/pdf');
  });

  it('detects docx from .docx', () => {
    expect(normaliseContentType('doc.docx', '')).toBe(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    );
  });

  it('is case-insensitive on file extensions', () => {
    expect(normaliseContentType('DOC.PDF', '')).toBe('application/pdf');
    expect(normaliseContentType('Page.HTML', '')).toBe('text/html');
  });

  it('falls back to the original headerType when the extension is unknown', () => {
    expect(normaliseContentType('foo.weird', 'text/x-something')).toBe('text/x-something');
  });

  it('returns octet-stream as a last resort with no header and unknown ext', () => {
    expect(normaliseContentType('foo.weird', '')).toBe('application/octet-stream');
  });
});

// =====================================================================
// isSupported — allowlist gate on /api/upload
// =====================================================================

describe('isSupported', () => {
  it('accepts every type in ALLOWED_CONTENT_TYPES', () => {
    for (const ct of ALLOWED_CONTENT_TYPES) {
      expect(isSupported(ct)).toBe(true);
    }
  });

  it('rejects unrelated MIME types', () => {
    expect(isSupported('image/png')).toBe(false);
    expect(isSupported('audio/mpeg')).toBe(false);
    expect(isSupported('application/zip')).toBe(false);
    expect(isSupported('application/octet-stream')).toBe(false);
  });

  it('rejects empty / nonsense input', () => {
    expect(isSupported('')).toBe(false);
    expect(isSupported('not-a-mime')).toBe(false);
  });

  it('lists exactly five allowed extensions', () => {
    // Tripwire: if someone adds a new format, both the extractors and
    // these tests should be updated together.
    expect(ALLOWED_EXTENSIONS).toHaveLength(7); // .md, .markdown, .txt, .html, .htm, .pdf, .docx
  });
});

// =====================================================================
// extract — markdown (real gray-matter parsing)
// =====================================================================

describe('extract (markdown)', () => {
  it('reads frontmatter title when present', async () => {
    const raw = '---\ntitle: My Doc\n---\n\nBody content here.';
    const buf = Buffer.from(raw, 'utf8');
    const out = await extract(buf, 'whatever.md', 'text/markdown');
    expect(out.title).toBe('My Doc');
    expect(out.text).toBe('Body content here.');
    expect(out.detectedContentType).toBe('text/markdown');
  });

  it('falls back to humanised filename when frontmatter omits title', async () => {
    const raw = 'just body, no frontmatter';
    const buf = Buffer.from(raw, 'utf8');
    const out = await extract(buf, 'town-hall-notes-2026-q1.md', 'text/markdown');
    expect(out.title).toBe('Town Hall Notes 2026 Q1');
    expect(out.text).toBe('just body, no frontmatter');
  });

  it('handles frontmatter with extra fields the extractor ignores', async () => {
    const raw =
      '---\ntitle: HR Policy\nauthor: Alice\ndate: 2026-01-01\n---\nBody only.';
    const buf = Buffer.from(raw, 'utf8');
    const out = await extract(buf, 'foo.md', 'text/markdown');
    expect(out.title).toBe('HR Policy');
    expect(out.text).toBe('Body only.');
  });

  it('falls back to filename when frontmatter title is empty string', async () => {
    const raw = '---\ntitle: ""\n---\nBody.';
    const buf = Buffer.from(raw, 'utf8');
    const out = await extract(buf, 'fallback.md', 'text/markdown');
    expect(out.title).toBe('Fallback');
  });

  it('strips UTF-8 BOM from the front of the buffer', async () => {
    const raw = '---\ntitle: BOM Test\n---\nHello.';
    const buf = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(raw, 'utf8')]);
    const out = await extract(buf, 'bom.md', 'text/markdown');
    expect(out.title).toBe('BOM Test');
    expect(out.text).toBe('Hello.');
  });

  it('falls back to RAW input as text when frontmatter leaves an empty body', async () => {
    // Documents the current extractor behaviour: when the markdown body
    // is empty after frontmatter strip, `(parsed.content || raw)` falls
    // through to the raw frontmatter string. The upload route's empty-
    // text guard (text.trim().length < 10) then rejects most such docs
    // with a friendly "extracted text is empty or too short" error, so
    // this fallthrough rarely matters in practice — but it's a documented
    // behaviour and changing it would need a separate ticket.
    const raw = '---\ntitle: Empty Body\n---\n';
    const buf = Buffer.from(raw, 'utf8');
    const out = await extract(buf, 'empty.md', 'text/markdown');
    expect(out.title).toBe('Empty Body');
    expect(out.text).toContain('title: Empty Body');
  });
});

// =====================================================================
// extract — plain text
// =====================================================================

describe('extract (text)', () => {
  it('returns the buffer as-is (trimmed) and humanises the filename', async () => {
    const buf = Buffer.from('   plain text content   \n', 'utf8');
    const out = await extract(buf, 'parental-leave-update.txt', 'text/plain');
    expect(out.text).toBe('plain text content');
    expect(out.title).toBe('Parental Leave Update');
    expect(out.detectedContentType).toBe('text/plain');
  });

  it('strips UTF-8 BOM from .txt buffer', async () => {
    const buf = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('hello', 'utf8')]);
    const out = await extract(buf, 'foo.txt', 'text/plain');
    expect(out.text).toBe('hello');
  });

  it('returns empty text for an empty buffer', async () => {
    const out = await extract(Buffer.alloc(0), 'empty.txt', 'text/plain');
    expect(out.text).toBe('');
    expect(out.title).toBe('Empty');
  });

  it('handles multibyte UTF-8 (Vietnamese)', async () => {
    const buf = Buffer.from('Tóm tắt chính sách công ty', 'utf8');
    const out = await extract(buf, 'tom-tat.txt', 'text/plain');
    expect(out.text).toBe('Tóm tắt chính sách công ty');
  });
});

// =====================================================================
// extract — HTML (real regex-based stripping)
// =====================================================================

describe('extract (html)', () => {
  it('reads <title> when present', async () => {
    // Quirk: the regex stripper removes the <title> and </title> TAGS
    // but keeps the inner text, so the title content also appears in the
    // body. Acceptable for RAG (the title appearing twice is a tiny
    // duplication, not a leak), but worth documenting.
    const html = '<html><head><title>HR Handbook</title></head><body><p>Hi</p></body></html>';
    const buf = Buffer.from(html, 'utf8');
    const out = await extract(buf, 'whatever.html', 'text/html');
    expect(out.title).toBe('HR Handbook');
    expect(out.text).toContain('Hi');
    expect(out.text).toContain('HR Handbook'); // duplicated from title — known
    expect(out.detectedContentType).toBe('text/html');
  });

  it('falls back to humanised filename when no <title> tag', async () => {
    const html = '<html><body><p>No title here</p></body></html>';
    const buf = Buffer.from(html, 'utf8');
    const out = await extract(buf, 'recruiting-rubric.html', 'text/html');
    expect(out.title).toBe('Recruiting Rubric');
  });

  it('strips <script> and <style> blocks', async () => {
    const html =
      '<html><head><script>alert(1)</script><style>body{}</style></head>' +
      '<body><p>visible content</p></body></html>';
    const buf = Buffer.from(html, 'utf8');
    const out = await extract(buf, 'foo.html', 'text/html');
    expect(out.text).toContain('visible content');
    expect(out.text).not.toContain('alert');
    expect(out.text).not.toContain('body{}');
  });

  it('decodes the common HTML entities', async () => {
    const html = '<html><body><p>5 &amp; 6 are &lt;numbers&gt; &quot;here&quot;</p></body></html>';
    const buf = Buffer.from(html, 'utf8');
    const out = await extract(buf, 'foo.html', 'text/html');
    expect(out.text).toContain('5 & 6');
    expect(out.text).toContain('<numbers>');
    expect(out.text).toContain('"here"');
  });

  it('inserts newlines between block elements (p, div, h1-h6, br, li, tr)', async () => {
    const html = '<html><body><p>one</p><p>two</p><h1>three</h1></body></html>';
    const buf = Buffer.from(html, 'utf8');
    const out = await extract(buf, 'foo.html', 'text/html');
    // Each block ends with \n, so the output has at least one \n between them.
    expect(out.text.split('\n').filter(Boolean).length).toBeGreaterThanOrEqual(3);
  });
});

// =====================================================================
// extract — dispatch + error paths
// =====================================================================

describe('extract (dispatch)', () => {
  it('throws for an unsupported content type', async () => {
    await expect(extract(Buffer.from('x'), 'foo.png', 'image/png')).rejects.toThrow(
      /Unsupported content type/
    );
  });

  it('uses normaliseContentType on octet-stream + extension', async () => {
    // Browser sends octet-stream for an .md file; extractor must still
    // dispatch to extractMarkdown (proven by the frontmatter parsing).
    const raw = '---\ntitle: Dispatched OK\n---\nbody';
    const buf = Buffer.from(raw, 'utf8');
    const out = await extract(buf, 'foo.md', 'application/octet-stream');
    expect(out.title).toBe('Dispatched OK');
    expect(out.detectedContentType).toBe('text/markdown');
  });
});
