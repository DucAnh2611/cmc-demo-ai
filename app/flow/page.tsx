import Link from 'next/link';
import CopyButton from './CopyButton';

export const metadata = {
  title: 'Security & Document Flow · Secure RAG Demo'
};

interface LayerRow {
  num: number;
  title: string;
  role: string;
  tech: string;
  tone: 'auth' | 'orch' | 'search' | 'context' | 'llm' | 'user';
}

const LAYERS: LayerRow[] = [
  { num: 1, title: 'User', role: 'End user asks a question via the chat UI.', tech: 'Browser / mobile', tone: 'user' },
  { num: 2, title: 'Application (Auth via Entra ID)', role: 'Authenticates the user, obtains an access token containing oid + group memberships.', tech: 'Microsoft Entra ID, MSAL React', tone: 'auth' },
  { num: 3, title: 'Policy / Orchestration Layer', role: 'Verifies the token, calls Microsoft Graph for groups, builds the security filter, runs the audit log.', tech: 'Next.js API route (/api/chat)', tone: 'orch' },
  { num: 4, title: 'Azure AI Search (Vector + ACL)', role: 'Vector search combined with an ACL filter. Returns only chunks the user is authorized to read.', tech: 'Azure AI Search (security trimming via search.in)', tone: 'search' },
  { num: 5, title: 'Authorized Context Only', role: 'Conceptual layer: Claude only ever sees chunks that have already passed the ACL filter.', tech: '(logical — enforced upstream)', tone: 'context' },
  { num: 6, title: 'Claude', role: 'Generates the answer from the authorized context. Cannot reach data the user is not allowed to see.', tech: 'Anthropic API (claude-haiku-4-5)', tone: 'llm' }
];

const REQUEST_FLOW: Array<{ n: number; text: React.ReactNode }> = [
  { n: 1, text: <>User signs in via MSAL → Entra returns an access token with <code>oid</code> + <code>groups</code> claim.</> },
  { n: 2, text: <>Frontend POSTs <code>{'{ message }'}</code> + <code>Authorization: Bearer …</code> to <code>/api/chat</code>. Frontend never sends groups.</> },
  { n: 3, text: <>Backend verifies the token (audience, issuer, expiry, oid). Strict body schema rejects any field other than <code>message</code>.</> },
  { n: 4, text: <>Backend calls Microsoft Graph <code>/me/transitiveMemberOf</code> with the user&rsquo;s token to get the authoritative group list. Cached 5 min, keyed by token.</> },
  { n: 5, text: <>Backend embeds the question via Azure OpenAI <code>text-embedding-3-small</code> → 1536-dim vector.</> },
  { n: 6, text: <>Backend builds the OData filter <code>{`allowedGroups/any(g: search.in(g, '<g1>,<g2>,…'))`}</code> and sends it to Azure AI Search alongside the vector query.</> },
  { n: 7, text: <>Azure AI Search applies the filter inside the search engine. Chunks the user can&rsquo;t read never leave the index.</> },
  { n: 8, text: <>Backend runs a final-mile ACL re-check on each chunk&rsquo;s <code>allowedGroups</code> before the prompt is built.</> },
  { n: 9, text: <>Backend builds the prompt (system + question + filtered chunks) and streams it to Anthropic. <strong>Claude only ever sees authorized chunks.</strong></> },
  { n: 10, text: <>SSE streams tokens back. After the answer, citations are filtered to docs Claude actually mentioned. An audit record is written: <code>user_oid, query, doc_ids, response_preview</code>.</> }
];

const INDEX_FLOW: Array<{ n: number; text: React.ReactNode }> = [
  { n: 1, text: <>Read <code>.md</code> files from <code>sample-docs/&lt;dept&gt;/</code>, parse YAML frontmatter (<code>title, allowedGroups</code>).</> },
  { n: 2, text: <>Resolve placeholder group IDs (<code>GROUP_HR_ID</code>, …) to real Entra group GUIDs from <code>.env.local</code>.</> },
  { n: 3, text: <>Chunk the body into ~500-token pieces, embed each chunk via Azure OpenAI.</> },
  { n: 4, text: <>Mirror the original file to Blob at <code>docs/&lt;dept&gt;/&lt;name&gt;</code>, then upload chunks (with <code>blobName</code>) to Azure AI Search.</> }
];

const UPLOAD_RULES: Array<{ k: string; v: React.ReactNode }> = [
  { k: 'Who can upload', v: <>Members of the Entra group set in <code>GROUP_UPLOADERS_ID</code> only. Everyone else gets HTTP 403 from <code>/api/upload</code>, plus a clear &ldquo;no permission&rdquo; banner in the UI.</> },
  { k: 'How many files', v: <>Up to <strong>5 files per upload</strong> session.</> },
  { k: 'Size limit', v: <>Up to <strong>10 MB per file</strong>. Larger files rejected client- and server-side.</> },
  { k: 'Allowed types', v: <>Markdown (<code>.md</code>), text (<code>.txt</code>), HTML (<code>.html</code>), PDF (<code>.pdf</code>), Word (<code>.docx</code>). Anything else returns 415.</> },
  { k: 'Who you can share with', v: <>Only groups <strong>you yourself are a member of</strong>. Backend re-validates against Microsoft Graph on every request — frontend selections are never trusted.</> },
  { k: 'Department label', v: <>Auto-derived from the picked groups: HR group → <code>hr</code>, Finance → <code>finance</code>, Public-only → <code>public</code>, otherwise <code>uploads</code>.</> },
  { k: 'Where it&rsquo;s stored', v: <>Original binary in Blob at <code>uploads/docs/&lt;dept&gt;/&lt;short-id&gt;-&lt;safe-name&gt;.&lt;ext&gt;</code>. Chunks in Azure AI Search with <code>blobName</code> pointing back.</> },
  { k: 'Uploader retains access', v: <>The chunk&rsquo;s <code>allowedUsers</code> always includes the uploader&rsquo;s <code>oid</code>, so they can still read their own upload even if they later leave one of the chosen groups.</> }
];

const TONE_CLASSES: Record<LayerRow['tone'], string> = {
  user: 'border-slate-200 bg-slate-50',
  auth: 'border-blue-200 bg-blue-50',
  orch: 'border-indigo-200 bg-indigo-50',
  search: 'border-purple-200 bg-purple-50',
  context: 'border-amber-200 bg-amber-50',
  llm: 'border-emerald-200 bg-emerald-50'
};

export default function FlowPage() {
  return (
    <main className="min-h-screen bg-slate-50 px-6 py-10">
      <div className="mx-auto max-w-3xl">
        <Link href="/" className="text-sm text-slate-500 underline hover:text-slate-900">
          ← Back to chat
        </Link>

        <header className="mt-6">
          <h1 className="text-3xl font-semibold text-slate-900">Security &amp; document flow</h1>
          <p className="mt-2 text-sm text-slate-600">
            Four sections: how a request travels through the system, what each piece of tech does,
            how documents get into the system (seed + upload), and how Azure resources fit together.
          </p>
          <nav className="mt-4 flex flex-wrap gap-2 text-xs">
            <a href="#section-accounts" className="rounded-full border border-slate-300 px-3 py-1 text-slate-700 hover:bg-white">Demo accounts</a>
            <a href="#section-flows" className="rounded-full border border-slate-300 px-3 py-1 text-slate-700 hover:bg-white">1 · Flows</a>
            <a href="#section-tech" className="rounded-full border border-slate-300 px-3 py-1 text-slate-700 hover:bg-white">2 · Tech</a>
            <a href="#section-upload" className="rounded-full border border-slate-300 px-3 py-1 text-slate-700 hover:bg-white">3 · Upload</a>
            <a href="#section-azure" className="rounded-full border border-slate-300 px-3 py-1 text-slate-700 hover:bg-white">4 · Azure</a>
          </nav>
        </header>

        {/* ==================================================================
            DEMO ACCOUNTS — visible without login so stakeholders can pick a
            user before they sign in to the chat UI
            ================================================================== */}
        <section id="section-accounts" className="mt-10 scroll-mt-6">
          <h2 className="text-xl font-semibold text-slate-900">Demo accounts</h2>
          <p className="mt-1 text-sm text-slate-600">
            Sign in to the chat at <Link href="/login" className="underline hover:text-slate-900"><code>/login</code></Link>{' '}
            with any of these. Same password for all three.
          </p>
          <div className="mt-3 overflow-x-auto rounded-lg border border-slate-200 bg-white">
            <table className="w-full text-left text-sm">
              <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-4 py-2">Account</th>
                  <th className="px-4 py-2">Sees in chat</th>
                  <th className="px-4 py-2">Can upload?</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                <tr>
                  <td className="px-4 py-3 align-top">
                    <div className="flex items-center">
                      <code>alice@evilcatkimigmail.onmicrosoft.com</code>
                      <CopyButton value="alice@evilcatkimigmail.onmicrosoft.com" label="alice email" />
                    </div>
                  </td>
                  <td className="px-4 py-3 align-top text-slate-700">HR docs + Public docs</td>
                  <td className="px-4 py-3 align-top text-slate-700">No</td>
                </tr>
                <tr>
                  <td className="px-4 py-3 align-top">
                    <div className="flex items-center">
                      <code>bob@evilcatkimigmail.onmicrosoft.com</code>
                      <CopyButton value="bob@evilcatkimigmail.onmicrosoft.com" label="bob email" />
                    </div>
                  </td>
                  <td className="px-4 py-3 align-top text-slate-700">Finance docs + Public docs</td>
                  <td className="px-4 py-3 align-top text-slate-700">No</td>
                </tr>
                <tr>
                  <td className="px-4 py-3 align-top">
                    <div className="flex items-center">
                      <code>upload@evilcatkimigmail.onmicrosoft.com</code>
                      <CopyButton value="upload@evilcatkimigmail.onmicrosoft.com" label="upload email" />
                    </div>
                  </td>
                  <td className="px-4 py-3 align-top text-slate-700">All three (HR + Finance + Public)</td>
                  <td className="px-4 py-3 align-top text-slate-700">Yes — to any group they belong to</td>
                </tr>
              </tbody>
            </table>
          </div>
          <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="font-semibold">Password (all three):</span>
              <code className="font-mono">Hoanganh268*</code>
              <CopyButton value="Hoanganh268*" label="password" />
            </div>
            <div className="mt-2 text-amber-800">
              Demo-only credentials — rotate or disable after the demo session.
            </div>
          </div>
        </section>

        {/* ==================================================================
            SECTION 1 — FLOWS
            ================================================================== */}
        <section id="section-flows" className="mt-12 scroll-mt-6">
          <h2 className="text-xl font-semibold text-slate-900">1 · Flows — how we work</h2>

          <h3 className="mt-6 text-sm font-semibold uppercase tracking-wide text-slate-500">
            Chat request — what happens when a user asks a question
          </h3>
          <div className="mt-3 rounded-lg border border-slate-200 bg-white p-4">
            <pre className="overflow-x-auto text-[11px] leading-snug text-slate-700">
{`   BROWSER                    NEXT.JS API                EXTERNAL SERVICES
   ┌──────────┐                ┌──────────────────┐
   │ Sign in  │ ─────token───▶ │ verifyToken      │
   └──────────┘                │   (claims-only)  │
        │                      └────────┬─────────┘
        │ ask question                  │
        ▼                               ▼
   ┌──────────┐  POST /api/chat ┌──────────────────┐         ┌──────────────────┐
   │ Bearer + │ ───────────────▶│ getUserGroups    │ ──────▶ │ Microsoft Graph  │
   │ message  │                 │ (5-min cache)    │ ◀────── │ transitiveMember │
   └──────────┘                 └────────┬─────────┘         └──────────────────┘
                                         ▼
                                ┌──────────────────┐         ┌──────────────────┐
                                │ embed(question)  │ ──────▶ │ Azure OpenAI     │
                                │                  │ ◀────── │ embeddings       │
                                └────────┬─────────┘         └──────────────────┘
                                         ▼
                                ┌──────────────────┐         ┌──────────────────┐
                                │ secureSearch     │ ──────▶ │ Azure AI Search  │
                                │ vector + ACL     │ ◀────── │ (ACL filter)     │
                                └────────┬─────────┘         └──────────────────┘
                                         ▼
                                ┌──────────────────┐
                                │ final-mile ACL   │   chunks dropped if any
                                │   re-check       │   slipped past the filter
                                └────────┬─────────┘
                                         ▼
                                ┌──────────────────┐         ┌──────────────────┐
                                │ build prompt +   │ ──────▶ │ Anthropic API    │
                                │ stream to Claude │ ◀────── │ (haiku-4-5)      │
                                └────────┬─────────┘         └──────────────────┘
                                         ▼
                                ┌──────────────────┐         ┌──────────────────┐
                                │ audit log        │ ──────▶ │ Application      │
                                │                  │         │ Insights traces  │
                                └────────┬─────────┘         └──────────────────┘
                                         │
   ┌──────────┐  SSE tokens              │
   │ render   │ ◀────────────────────────┘
   └──────────┘`}
            </pre>
          </div>

          <ol className="relative mt-4 space-y-3 border-l border-slate-200 pl-6">
            {REQUEST_FLOW.map((s) => (
              <li key={s.n} className="relative">
                <span className="absolute -left-[2.0625rem] flex h-6 w-6 items-center justify-center rounded-full bg-slate-900 text-xs font-semibold text-white">
                  {s.n}
                </span>
                <div className="text-sm text-slate-700">{s.text}</div>
              </li>
            ))}
          </ol>

          <h3 className="mt-10 text-sm font-semibold uppercase tracking-wide text-slate-500">
            Indexing flow — how documents get into the system
          </h3>
          <div className="mt-3 rounded-lg border border-slate-200 bg-white p-4">
            <pre className="overflow-x-auto text-[11px] leading-snug text-slate-700">
{`SEED (developer source)               UPLOAD (user-published)
sample-docs/<dept>/*.md                /api/upload (PDF / DOCX / MD / TXT / HTML)
        │                                       │
        │ npm run index-docs                    │ extract text per file type
        │                                       │ (mammoth / pdf-parse / passthrough)
        ▼                                       ▼
        ┌──────────────────────────────────────────────┐
        │  Chunk to ~500 tokens                        │
        │  Embed each chunk via Azure OpenAI           │
        └─────────────────────┬────────────────────────┘
                              │
            ┌─────────────────┼─────────────────┐
            ▼                                   ▼
   ┌──────────────────┐                ┌──────────────────┐
   │ Azure AI Search  │                │ Azure Blob       │
   │ secure-docs-     │                │ uploads/docs/    │
   │   index          │                │   <dept>/<name>  │
   │                  │                │                  │
   │ chunk fields:    │                │ originals stored │
   │  id, content,    │                │ for download     │
   │  contentVector,  │                │                  │
   │  allowedGroups,  │                │ chunk.blobName ──┘ (pointer
   │  allowedUsers,   │                                       back)
   │  blobName,       │
   │  uploader_oid    │
   └──────────────────┘`}
            </pre>
          </div>

          <ol className="relative mt-4 space-y-3 border-l border-slate-200 pl-6">
            {INDEX_FLOW.map((s) => (
              <li key={s.n} className="relative">
                <span className="absolute -left-[2.0625rem] flex h-6 w-6 items-center justify-center rounded-full bg-purple-600 text-xs font-semibold text-white">
                  {s.n}
                </span>
                <div className="text-sm text-slate-700">{s.text}</div>
              </li>
            ))}
          </ol>
        </section>

        {/* ==================================================================
            SECTION 2 — TECH
            ================================================================== */}
        <section id="section-tech" className="mt-14 scroll-mt-6">
          <h2 className="text-xl font-semibold text-slate-900">2 · Tech — how this works</h2>
          <p className="mt-1 text-sm text-slate-600">
            Six logical layers. The ACL gate sits at layer 4 (Azure AI Search), with a redundant
            check in layer 3 (orchestration). Layer 5 is conceptual — it&rsquo;s the contract that
            Claude (layer 6) only ever sees the authorized output of layer 4.
          </p>
          <ol className="mt-4 space-y-2">
            {LAYERS.map((L) => (
              <li key={L.num} className={`rounded-lg border p-4 ${TONE_CLASSES[L.tone]}`}>
                <div className="flex items-start gap-3">
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-white text-sm font-semibold text-slate-900 ring-1 ring-slate-300">
                    {L.num}
                  </span>
                  <div className="min-w-0">
                    <div className="font-semibold text-slate-900">{L.title}</div>
                    <div className="mt-1 text-sm text-slate-700">{L.role}</div>
                    <div className="mt-1 text-xs uppercase tracking-wide text-slate-500">{L.tech}</div>
                  </div>
                </div>
              </li>
            ))}
          </ol>

          <h3 className="mt-8 text-sm font-semibold uppercase tracking-wide text-slate-500">
            Tech stack at a glance
          </h3>
          <div className="mt-3 overflow-x-auto rounded-lg border border-slate-200 bg-white">
            <table className="w-full text-left text-sm">
              <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-4 py-2">Layer</th>
                  <th className="px-4 py-2">Tech / library</th>
                  <th className="px-4 py-2">Where in code</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                <tr>
                  <td className="px-4 py-2 align-top">Frontend</td>
                  <td className="px-4 py-2 align-top">Next.js 14, React, Tailwind, MSAL React</td>
                  <td className="px-4 py-2 align-top font-mono text-xs">app/page.tsx, app/login/page.tsx</td>
                </tr>
                <tr>
                  <td className="px-4 py-2 align-top">Auth (browser)</td>
                  <td className="px-4 py-2 align-top">@azure/msal-browser</td>
                  <td className="px-4 py-2 align-top font-mono text-xs">app/providers/MsalProvider.tsx</td>
                </tr>
                <tr>
                  <td className="px-4 py-2 align-top">Auth (server)</td>
                  <td className="px-4 py-2 align-top">jsonwebtoken (claims-only validation)</td>
                  <td className="px-4 py-2 align-top font-mono text-xs">lib/auth/verifyToken.ts</td>
                </tr>
                <tr>
                  <td className="px-4 py-2 align-top">Groups</td>
                  <td className="px-4 py-2 align-top">Microsoft Graph (transitiveMemberOf)</td>
                  <td className="px-4 py-2 align-top font-mono text-xs">lib/auth/getUserGroups.ts</td>
                </tr>
                <tr>
                  <td className="px-4 py-2 align-top">Embeddings</td>
                  <td className="px-4 py-2 align-top">Azure OpenAI text-embedding-3-small</td>
                  <td className="px-4 py-2 align-top font-mono text-xs">lib/search/embedder.ts</td>
                </tr>
                <tr>
                  <td className="px-4 py-2 align-top">Search</td>
                  <td className="px-4 py-2 align-top">@azure/search-documents (vector + filter)</td>
                  <td className="px-4 py-2 align-top font-mono text-xs">lib/search/secureSearch.ts</td>
                </tr>
                <tr>
                  <td className="px-4 py-2 align-top">LLM</td>
                  <td className="px-4 py-2 align-top">@anthropic-ai/sdk (Claude haiku-4-5)</td>
                  <td className="px-4 py-2 align-top font-mono text-xs">lib/claude/client.ts</td>
                </tr>
                <tr>
                  <td className="px-4 py-2 align-top">Storage</td>
                  <td className="px-4 py-2 align-top">@azure/storage-blob</td>
                  <td className="px-4 py-2 align-top font-mono text-xs">lib/storage/blobClient.ts</td>
                </tr>
                <tr>
                  <td className="px-4 py-2 align-top">File extraction</td>
                  <td className="px-4 py-2 align-top">mammoth (DOCX), pdf-parse (PDF), gray-matter (MD)</td>
                  <td className="px-4 py-2 align-top font-mono text-xs">lib/extractors/index.ts</td>
                </tr>
                <tr>
                  <td className="px-4 py-2 align-top">Audit</td>
                  <td className="px-4 py-2 align-top">applicationinsights (App Insights traces)</td>
                  <td className="px-4 py-2 align-top font-mono text-xs">lib/audit/logger.ts</td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>

        {/* ==================================================================
            SECTION 3 — UPLOAD
            ================================================================== */}
        <section id="section-upload" className="mt-14 scroll-mt-6">
          <h2 className="text-xl font-semibold text-slate-900">3 · Upload — import documents into the system</h2>
          <p className="mt-1 text-sm text-slate-600">
            Documents come in through two paths: <strong>seed indexing</strong> (developer-curated
            files in <code>sample-docs/</code>, imported by <code>npm run index-docs</code>) and{' '}
            <strong>user upload</strong> via the in-app modal. Both paths converge on the same
            chunk schema in Azure AI Search and the same <code>uploads/docs/&lt;dept&gt;/…</code>{' '}
            layout in Blob Storage.
          </p>

          <h3 className="mt-6 text-sm font-semibold uppercase tracking-wide text-slate-500">
            What you can upload
          </h3>
          <ul className="mt-3 space-y-3">
            {UPLOAD_RULES.map((r) => (
              <li key={r.k} className="rounded-lg border border-slate-200 bg-white p-4">
                <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">{r.k}</div>
                <div className="mt-1 text-sm text-slate-700">{r.v}</div>
              </li>
            ))}
          </ul>

          <h3 className="mt-8 text-sm font-semibold uppercase tracking-wide text-slate-500">
            How an upload travels through the system
          </h3>
          <div className="mt-3 rounded-lg border border-slate-200 bg-white p-4">
            <pre className="overflow-x-auto text-[11px] leading-snug text-slate-700">
{`USER PICKS GROUPS + FILES
        │
        │ POST /api/upload  (multipart/form-data, Bearer token)
        ▼
   verify token (claims-only)
        ▼
   getUserGroups(token)  ──▶ MS Graph
        ▼
   ┌──────────────────────────────────────────┐
   │  GATE 1: must be member of               │
   │          GROUP_UPLOADERS_ID              │
   │  GATE 2: every requested allowedGroup    │
   │          must be one user belongs to     │
   │          (strict ACL on share targets)   │
   │  GATE 3: file count ≤ 5,                 │
   │          per-file ≤ 10 MB,               │
   │          MIME in allowlist               │
   └─────────────────┬────────────────────────┘
                     ▼
   for each file: extract text
       (mammoth | pdf-parse | passthrough)
                     ▼
   chunk → embed each chunk (Azure OpenAI)
                     ▼
   ┌──────────────────────────────────────────┐
   │  Write original to Azure Blob            │
   │   uploads/docs/<dept>/<id>-<safe-name>   │
   │  metadata: uploader_oid, allowed_groups, │
   │            original_filename             │
   └─────────────────┬────────────────────────┘
                     ▼
   Upload chunks to Azure AI Search
   (id, content, contentVector,
    allowedGroups, allowedUsers=[uploader],
    department, uploader_oid, blobName)
                     ▼
   Audit log: who uploaded what, to which groups`}
            </pre>
          </div>

          <h3 className="mt-8 text-sm font-semibold uppercase tracking-wide text-slate-500">
            Demo accounts
          </h3>
          <div className="mt-3 overflow-x-auto rounded-lg border border-slate-200 bg-white">
            <table className="w-full text-left text-sm">
              <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-4 py-2">Account</th>
                  <th className="px-4 py-2">Group memberships</th>
                  <th className="px-4 py-2">Can publish to</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                <tr>
                  <td className="px-4 py-3 align-top font-medium text-slate-900">upload</td>
                  <td className="px-4 py-3 align-top text-slate-700">HR + Finance + Public + uploaders</td>
                  <td className="px-4 py-3 align-top text-slate-700">Any subset of HR, Finance, Public — picks per upload in the modal</td>
                </tr>
                <tr>
                  <td className="px-4 py-3 align-top font-medium text-slate-900">alice</td>
                  <td className="px-4 py-3 align-top text-slate-700">HR + Public</td>
                  <td className="px-4 py-3 align-top text-slate-700">— (no upload permission; read-only)</td>
                </tr>
                <tr>
                  <td className="px-4 py-3 align-top font-medium text-slate-900">bob</td>
                  <td className="px-4 py-3 align-top text-slate-700">Finance + Public</td>
                  <td className="px-4 py-3 align-top text-slate-700">— (no upload permission; read-only)</td>
                </tr>
              </tbody>
            </table>
          </div>

          <h3 className="mt-8 text-sm font-semibold uppercase tracking-wide text-slate-500">
            How to upload (UI walkthrough)
          </h3>
          <ol className="mt-3 list-decimal space-y-2 pl-5 text-sm text-slate-700">
            <li>Sign in as a member of the uploaders group (e.g. <code>upload</code>).</li>
            <li>Click <strong>+ Upload</strong> in the chat header.</li>
            <li>In the modal, tick the groups you want to share with — only groups you belong to (other than the uploaders group itself) are shown.</li>
            <li>Click <strong>Choose files</strong> and pick up to 5 files. Each file&rsquo;s size is shown for confirmation.</li>
            <li>Click <strong>Upload N files</strong>. Per-file results appear inline; click <strong>View</strong> on any successful row to open it in the source modal.</li>
          </ol>
        </section>

        {/* ==================================================================
            SECTION 4 — AZURE
            ================================================================== */}
        <section id="section-azure" className="mt-14 scroll-mt-6">
          <h2 className="text-xl font-semibold text-slate-900">4 · How Azure handles everything</h2>
          <p className="mt-1 text-sm text-slate-600">
            Five Azure resources plus one external service (Anthropic). Each has one job; the
            backend orchestrates them. All data at rest stays in Azure (Search index + Blob
            + App Insights). Only the prompt + retrieved chunks transit out to Anthropic at
            answer-generation time.
          </p>

          <h3 className="mt-6 text-sm font-semibold uppercase tracking-wide text-slate-500">
            Resource diagram
          </h3>
          <div className="mt-3 rounded-lg border border-slate-200 bg-white p-4">
            <pre className="overflow-x-auto text-[11px] leading-snug text-slate-700">
{`               ┌────────────────────────────────────────────┐
               │       Azure subscription                   │
               │       Resource group: rg-claude-secure-…   │
               │                                            │
               │   ┌──────────────────┐                     │
               │   │ Microsoft Entra  │  identity provider  │
               │   │  ID tenant       │  (also Microsoft    │
               │   │  + app reg       │  Graph for groups)  │
               │   └──────────────────┘                     │
               │                                            │
               │   ┌──────────────────┐  ┌────────────────┐ │
               │   │ Azure AI Search  │  │ Azure OpenAI   │ │
               │   │ secure-docs-     │  │ text-embedding-│ │
               │   │   index          │  │   3-small      │ │
               │   │ (vector + ACL)   │  │ (1536-dim)     │ │
               │   └──────────────────┘  └────────────────┘ │
               │                                            │
               │   ┌──────────────────┐  ┌────────────────┐ │
               │   │ Azure Storage    │  │ Application    │ │
               │   │ container:       │  │ Insights       │ │
               │   │   uploads        │  │ traces table   │ │
               │   │ docs/<dept>/...  │  │ (audit log)    │ │
               │   └──────────────────┘  └────────────────┘ │
               │                                            │
               └─────────────────────┬──────────────────────┘
                                     │
                                     │  REST (server-side, with admin
                                     │   keys held in process.env;
                                     │   never reach the browser)
                                     ▼
                            ┌──────────────────┐         ┌──────────────────┐
                            │  Next.js API     │ ──────▶ │ Anthropic        │
                            │  /api/chat etc.  │ ◀────── │ api.anthropic    │
                            └────────┬─────────┘         └──────────────────┘
                                     │
                                     │  HTTPS to browser
                                     ▼
                              ┌──────────────────┐
                              │  Browser         │
                              │  (MSAL session)  │
                              └──────────────────┘`}
            </pre>
          </div>

          <h3 className="mt-8 text-sm font-semibold uppercase tracking-wide text-slate-500">
            What each Azure service does
          </h3>
          <div className="mt-3 overflow-x-auto rounded-lg border border-slate-200 bg-white">
            <table className="w-full text-left text-sm">
              <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-4 py-2">Service</th>
                  <th className="px-4 py-2">Role in this app</th>
                  <th className="px-4 py-2">What lives here</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                <tr>
                  <td className="px-4 py-3 align-top font-medium text-slate-900">Microsoft Entra ID</td>
                  <td className="px-4 py-3 align-top text-slate-700">Identity provider; issues access tokens; owns security groups that drive ACL.</td>
                  <td className="px-4 py-3 align-top text-slate-700">Tenant, app registration (SPA), user accounts (alice/bob/upload), security groups (HR/Finance/Public/Uploaders).</td>
                </tr>
                <tr>
                  <td className="px-4 py-3 align-top font-medium text-slate-900">Microsoft Graph</td>
                  <td className="px-4 py-3 align-top text-slate-700">Read API for resolving the user&rsquo;s group membership (transitiveMemberOf).</td>
                  <td className="px-4 py-3 align-top text-slate-700">Nothing app-specific — it&rsquo;s the front door to the Entra directory.</td>
                </tr>
                <tr>
                  <td className="px-4 py-3 align-top font-medium text-slate-900">Azure AI Search</td>
                  <td className="px-4 py-3 align-top text-slate-700">Vector search + ACL filter. The single point where retrieval meets authorization.</td>
                  <td className="px-4 py-3 align-top text-slate-700">Index <code>secure-docs-index</code>: chunks with id, content, 1536-dim vectors, allowedGroups, allowedUsers, department, uploader_oid, blobName.</td>
                </tr>
                <tr>
                  <td className="px-4 py-3 align-top font-medium text-slate-900">Azure OpenAI</td>
                  <td className="px-4 py-3 align-top text-slate-700">Embeddings only — turns text into 1536-dim vectors at index time and at query time.</td>
                  <td className="px-4 py-3 align-top text-slate-700">Deployment <code>text-embedding-3-small</code>. No chat/completion deployment used.</td>
                </tr>
                <tr>
                  <td className="px-4 py-3 align-top font-medium text-slate-900">Azure Blob Storage</td>
                  <td className="px-4 py-3 align-top text-slate-700">Stores the original document binaries. Private container; reads only via the backend API.</td>
                  <td className="px-4 py-3 align-top text-slate-700">Container <code>uploads</code>; paths <code>docs/&lt;dept&gt;/…</code> for both seeds and user uploads. Each blob carries metadata (uploader_oid, allowed_groups, original_filename).</td>
                </tr>
                <tr>
                  <td className="px-4 py-3 align-top font-medium text-slate-900">Application Insights</td>
                  <td className="px-4 py-3 align-top text-slate-700">Centralised audit log. Every chat and upload writes a structured trace.</td>
                  <td className="px-4 py-3 align-top text-slate-700"><code>traces</code> table; customDimensions match the §7.5 KQL: <code>audit_event, user_oid, query, doc_ids, response_preview</code>.</td>
                </tr>
                <tr>
                  <td className="px-4 py-3 align-top font-medium text-slate-900">Anthropic (external)</td>
                  <td className="px-4 py-3 align-top text-slate-700">LLM that generates the answer from the already-authorized context.</td>
                  <td className="px-4 py-3 align-top text-slate-700">No persistent storage. Prompt + chunks transit at request time only.</td>
                </tr>
              </tbody>
            </table>
          </div>

          <h3 className="mt-8 text-sm font-semibold uppercase tracking-wide text-slate-500">
            Data residency
          </h3>
          <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-slate-700">
            <li><strong>Documents at rest</strong>: Azure (Blob originals + Search index chunks).</li>
            <li><strong>User identity / groups</strong>: Microsoft Entra ID (tenant region).</li>
            <li><strong>Embeddings computation</strong>: Azure OpenAI region (typically same region as Search).</li>
            <li><strong>Audit log</strong>: Application Insights workspace (Azure region).</li>
            <li><strong>Answer generation</strong>: Anthropic (US-based by default). Only the user&rsquo;s question + retrieved chunks transit. Anthropic Zero Data Retention is available for enterprise contracts if required.</li>
          </ul>
        </section>

        <footer className="mt-14 border-t border-slate-200 pt-6 text-xs text-slate-500">
          <p>
            Diagrams reflect the live code paths in <code>app/api/chat/route.ts</code>,{' '}
            <code>app/api/upload/route.ts</code>, <code>lib/search/secureSearch.ts</code>,{' '}
            <code>lib/auth/getUserGroups.ts</code>, <code>lib/storage/blobClient.ts</code>,
            and <code>lib/envGuard.ts</code>. Behaviour is locked in by 11 tests under{' '}
            <code>tests/</code> — run <code>npm test</code>.
          </p>
          <p className="mt-2">
            <Link href="/" className="text-slate-600 underline hover:text-slate-900">
              ← Back to chat
            </Link>
          </p>
        </footer>
      </div>
    </main>
  );
}
