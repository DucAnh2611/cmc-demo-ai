import Link from 'next/link';
import CopyButton from './CopyButton';
import StepImage from './StepImage';

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
            Six sections: how a request travels through the system, what each piece of tech does,
            how to provision identity in Entra ID, how documents get into the system (seed + upload),
            how to manage users in-app, and how Azure resources fit together.
          </p>
        </header>

        {/* Section outline — sticky so it stays visible as the reader
            scrolls. Negative horizontal margin pulls it past the
            container's padding so the bottom border spans full width.
            Backdrop blur + slate-50/90 keeps page content readable when
            it scrolls under the nav. scroll-mt-20 on each section
            target leaves room for the nav's height when an anchor
            jumps. */}
        <nav className="sticky top-0 z-30 -mx-6 mt-4 flex flex-wrap gap-2 border-b border-slate-200 bg-slate-50/90 px-6 py-3 text-xs backdrop-blur supports-[backdrop-filter]:bg-slate-50/80">
          <a href="#section-flows" className="rounded-full border border-slate-300 bg-white px-3 py-1 text-slate-700 hover:bg-slate-100">1 · Flows</a>
          <a href="#section-tech" className="rounded-full border border-slate-300 bg-white px-3 py-1 text-slate-700 hover:bg-slate-100">2 · Tech</a>
          <a href="#section-setup" className="rounded-full border border-slate-300 bg-white px-3 py-1 text-slate-700 hover:bg-slate-100">3 · Setup</a>
          <a href="#section-upload" className="rounded-full border border-slate-300 bg-white px-3 py-1 text-slate-700 hover:bg-slate-100">4 · Upload</a>
          <a href="#section-admin" className="rounded-full border border-slate-300 bg-white px-3 py-1 text-slate-700 hover:bg-slate-100">5 · Admin</a>
          <a href="#section-azure" className="rounded-full border border-slate-300 bg-white px-3 py-1 text-slate-700 hover:bg-slate-100">6 · Azure</a>
        </nav>

        {/* ==================================================================
            SECTION 1 — FLOWS
            ================================================================== */}
        <section id="section-flows" className="mt-12 scroll-mt-20">
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
        <section id="section-tech" className="mt-14 scroll-mt-20">
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
            SECTION 3 — SETUP — how to provision identity in Entra ID.
            Comes after Tech because it's a "stand up your own copy" task,
            not part of the runtime story. Each subsection links straight
            to the relevant Azure portal blade so the operator doesn't
            have to navigate the menu tree.
            ================================================================== */}
        <section id="section-setup" className="mt-14 scroll-mt-20">
          <h2 className="text-xl font-semibold text-slate-900">3 · Setup — provision identity in Entra ID</h2>
          <p className="mt-1 text-sm text-slate-600">
            Recreating the demo in a clean tenant takes two short tasks: add users, then
            create the four security groups that drive the ACL. Both happen in the Azure portal
            (or via <code>az ad</code> CLI).
          </p>

          {/* Audience legend — separates "anyone with tenant admin can do
              this in the portal" from "only matters if you're running the
              demo codebase". Each step block uses these badges. */}
          <div className="mt-3 flex flex-wrap items-center gap-2 text-[11px]">
            <span className="inline-flex items-center gap-1 rounded-full border border-slate-300 bg-white px-2 py-0.5 font-medium text-slate-700">
              <span className="h-1.5 w-1.5 rounded-full bg-slate-700" /> Admin (portal)
            </span>
            <span className="text-slate-400">— a tenant admin (or User/Group Administrator role) can do this without touching code.</span>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px]">
            <span className="inline-flex items-center gap-1 rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 font-medium text-amber-800">
              <span className="h-1.5 w-1.5 rounded-full bg-amber-600" /> DEV ONLY
            </span>
            <span className="text-slate-400">— extra wiring needed only when running this demo codebase. Skip if you&rsquo;re just managing identity in the tenant.</span>
          </div>

          {/* ----- Create a group ----- */}
          {/* Groups come first: when adding users in Step B, the
              Assignments tab lets you drop them straight into already-
              existing groups, so the order saves a round-trip. */}
          <div className="mt-6 rounded-lg border border-slate-200 bg-white p-5">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="flex items-center gap-2">
                  <h3 className="text-base font-semibold text-slate-900">Step A · Create a group</h3>
                  <span className="inline-flex items-center gap-1 rounded-full border border-slate-300 bg-slate-50 px-2 py-0.5 text-[10px] font-medium text-slate-700">
                    <span className="h-1.5 w-1.5 rounded-full bg-slate-700" /> Admin (portal)
                  </span>
                </div>
                <p className="mt-1 text-xs text-slate-600">
                  Create one group per ACL slice the demo needs:{' '}
                  <code>group-hr-readers</code>, <code>group-finance-readers</code>,{' '}
                  <code>group-public-readers</code>, and (optionally){' '}
                  <code>group-uploaders</code> for the upload-permission gate.
                </p>
              </div>
              <a
                href="https://portal.azure.com/#view/Microsoft_AAD_IAM/GroupsManagementMenuBlade/~/Overview"
                target="_blank"
                rel="noreferrer"
                className="shrink-0 rounded-md bg-slate-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-800"
              >
                Open Groups blade ↗
              </a>
            </div>
            <ol className="mt-4 list-decimal space-y-2 pl-5 text-sm text-slate-700">
              <li>
                Open the <strong>All groups</strong> blade (button above) → click{' '}
                <strong>+ New group</strong>.
                <StepImage type="group" step={1} />
              </li>
              <li>
                On the <strong>Group</strong> form, fill in:
                <ul className="mt-1 list-disc space-y-0.5 pl-5 text-slate-600">
                  <li>
                    <strong>Group type</strong>: <code>Security</code> (NOT Microsoft 365 — only
                    Security groups appear in the user&rsquo;s{' '}
                    <code>transitiveMemberOf</code> token claim used for ACL).
                  </li>
                  <li>
                    <strong>Group name</strong>: use a clear, prefixed name like{' '}
                    <code>group-hr-readers</code>.
                  </li>
                  <li>
                    <strong>Group description</strong> (optional): explain what content this group
                    grants access to.
                  </li>
                  <li>
                    <strong>Membership type</strong>: <code>Assigned</code> (manual membership;
                    Dynamic membership requires Entra Premium P1).
                  </li>
                </ul>
                <StepImage type="group" step={2} />
              </li>
              <li>
                <strong>No members selected</strong> — leave it empty for now; we&rsquo;ll add
                members from the user side in Step B (or come back to the group&rsquo;s
                <em> Members</em> blade later).
              </li>
              <li>
                Click <strong>Create</strong>. The group appears in the list within a few
                seconds.
              </li>
              <li>
                Open the new group → <strong>Overview</strong> → copy the{' '}
                <strong>Object ID</strong> (a GUID like{' '}
                <code>68ff93bb-8e32-4b97-adac-2a07564f1406</code>). You&rsquo;ll need this for
                the dev wiring below — and for any code that filters by this group.
              </li>
            </ol>
            <p className="mt-3 text-[11px] text-slate-500">
              <strong>For a normal admin, that&rsquo;s it</strong> — the group exists, members
              you add (via Step B or the group&rsquo;s Members blade) can sign in to apps that
              ACL on it. Effective access in the demo chat updates within ~5 minutes of group
              changes (token re-issue + Graph cache TTL).
            </p>

            {/* DEV-ONLY follow-up — clearly visually separate from the
                portal steps above. Only matters when running THIS codebase. */}
            <div className="mt-4 rounded-md border border-amber-300 bg-amber-50 p-4">
              <div className="flex items-center gap-2">
                <span className="inline-flex items-center gap-1 rounded-full border border-amber-400 bg-white px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-amber-800">
                  <span className="h-1.5 w-1.5 rounded-full bg-amber-600" /> Dev only
                </span>
                <span className="text-[11px] font-medium text-amber-900">
                  wire the new group into this codebase
                </span>
              </div>
              <p className="mt-2 text-xs text-amber-900">
                Skip everything below if you&rsquo;re only managing identity in the tenant —
                these steps are needed only when running the demo&rsquo;s Next.js app. They
                map the new group&rsquo;s GUID to a named env var the seed indexer reads.
              </p>
              <ol start={6} className="mt-3 list-decimal space-y-2 pl-5 text-sm text-amber-900">
                <li>
                  Paste the Object ID into <code>.env.local</code> against the matching key:
                  <ul className="mt-1 list-disc space-y-0.5 pl-5 text-amber-800">
                    <li><code>GROUP_HR_ID</code> — for the HR readers group</li>
                    <li><code>GROUP_FINANCE_ID</code> — for the Finance readers group</li>
                    <li><code>GROUP_PUBLIC_ID</code> — for the Public readers group</li>
                    <li><code>GROUP_UPLOADERS_ID</code> — (optional) for the upload-permission gate</li>
                  </ul>
                </li>
                <li>
                  Restart the dev server <em>or</em> run <code>npm run index-docs</code> so the
                  indexer resolves the placeholder IDs in the seed docs to your real group GUIDs.
                </li>
              </ol>
            </div>
          </div>

          {/* ----- Add a user ----- */}
          <div className="mt-6 rounded-lg border border-slate-200 bg-white p-5">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="flex items-center gap-2">
                  <h3 className="text-base font-semibold text-slate-900">Step B · Add a user</h3>
                  <span className="inline-flex items-center gap-1 rounded-full border border-slate-300 bg-slate-50 px-2 py-0.5 text-[10px] font-medium text-slate-700">
                    <span className="h-1.5 w-1.5 rounded-full bg-slate-700" /> Admin (portal)
                  </span>
                </div>
                <p className="mt-1 text-xs text-slate-600">
                  Repeat for each demo identity (e.g. <code>alice</code>, <code>bob</code>,{' '}
                  <code>upload</code>). Sign in to Azure with an account that has the{' '}
                  <em>User Administrator</em> or <em>Global Administrator</em> role on the tenant.
                </p>
              </div>
              <a
                href="https://portal.azure.com/#view/Microsoft_AAD_UsersAndTenants/UserManagementMenuBlade/~/AllUsers"
                target="_blank"
                rel="noreferrer"
                className="shrink-0 rounded-md bg-slate-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-800"
              >
                Open Users blade ↗
              </a>
            </div>
            <ol className="mt-4 list-decimal space-y-2 pl-5 text-sm text-slate-700">
              <li>
                Open the <strong>All users</strong> blade (button above) → click{' '}
                <strong>+ New user</strong> → <strong>Create new user</strong>.
                <StepImage type="user" step={1} />
              </li>
              <li>
                On the <strong>Basics</strong> tab, fill in:
                <ul className="mt-1 list-disc space-y-0.5 pl-5 text-slate-600">
                  <li>
                    <strong>User principal name</strong> — the part before <code>@</code> (e.g.{' '}
                    <code>alice</code>). The full UPN becomes{' '}
                    <code>alice@&lt;your-tenant&gt;.onmicrosoft.com</code>.
                  </li>
                  <li>
                    <strong>Display name</strong> — what the chat UI shows (e.g. <code>Alice</code>).
                  </li>
                  <li>
                    <strong>Password</strong> — pick &ldquo;Auto-generate&rdquo; for production;
                    for the demo, &ldquo;Let me create the password&rdquo; with a strong shared
                    value is fine.
                  </li>
                  <li>
                    Leave <strong>Account enabled</strong> ticked.
                  </li>
                </ul>
                <StepImage type="user" step={2} />
              </li>
              <li>
                On the <strong>Properties</strong> tab (optional) — set a job title / department
                if you want the chat header to show something other than the UPN.
                <StepImage type="user" step={3} />
              </li>
              <li>
                On the <strong>Assignments</strong> tab — click{' '}
                <strong>+ Add group</strong> and pick the groups you created in Step A. This is
                the simplest way to wire ACL: pick HR + Public for an Alice-style user, Finance
                + Public for a Bob-style user, all three for an admin / uploader.
                <StepImage type="user" step={4} />
              </li>
              <li>
                Click <strong>Review + create</strong> → <strong>Create</strong>. The user
                appears in the list within a few seconds.
                <StepImage type="user" step={5} />
              </li>
              <li>
                <strong>First-login note for the user:</strong> they must sign in once to the
                Microsoft account portal (<code>myaccount.microsoft.com</code>) to set their
                permanent password before the demo app will accept their login.
                <StepImage type="user" step={6} />
              </li>
            </ol>
            <p className="mt-3 text-[11px] text-slate-500">
              Nothing dev-side to do for users — the demo code reads identity from the bearer
              token at request time. New users work as soon as they exist in the tenant and
              have been added to one of the groups from Step A.
            </p>
          </div>

          {/* ----- Verification tip ----- */}
          <div className="mt-4 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-xs text-emerald-900">
            <strong>Verify both steps in one command:</strong>{' '}
            <code>npm run verify:services</code> reads the GROUP_*_ID values from{' '}
            <code>.env.local</code> and prints them so you can confirm each group is
            wired correctly. Sign in as one of your new users in <code>/login</code> — the
            chat header shows their display name.
          </div>

          {/* ----- Demo accounts (result of Steps A + B) -----
              The four identities the demo expects to find after Setup
              completes. Lives here (not as its own section) because
              that's how it relates to the rest of the page: it's the
              expected outcome of running Steps A and B, not an
              independent narrative. */}
          <h3 className="mt-8 text-sm font-semibold uppercase tracking-wide text-slate-500">
            Demo accounts
          </h3>
          <p className="mt-2 text-sm text-slate-600">
            After running Steps A and B above you should end up with these four identities. Sign in
            to the chat at <Link href="/login" className="underline hover:text-slate-900"><code>/login</code></Link>{' '}
            with any of them — same password for all four.
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
                <tr>
                  <td className="px-4 py-3 align-top">
                    <div className="flex items-center">
                      <code>admin@evilcatkimigmail.onmicrosoft.com</code>
                      <CopyButton value="admin@evilcatkimigmail.onmicrosoft.com" label="admin email" />
                    </div>
                    <div className="mt-1 text-[10px] uppercase tracking-wide text-slate-500">App admin · sees Admin link in chat header</div>
                  </td>
                  <td className="px-4 py-3 align-top text-slate-700">
                    Every doc in the index (ACL filter bypassed)
                  </td>
                  <td className="px-4 py-3 align-top text-slate-700">
                    Yes — any group · plus full user / group CRUD via{' '}
                    <a href="#section-admin" className="underline hover:text-slate-900">§5</a>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="font-semibold">Password (all four):</span>
              <code className="font-mono">Hoanganh268*</code>
              <CopyButton value="Hoanganh268*" label="password" />
            </div>
            <div className="mt-2 text-amber-800">
              Demo-only credentials — rotate or disable after the demo session.
            </div>
          </div>
        </section>

        {/* ==================================================================
            SECTION 4 — UPLOAD
            ================================================================== */}
        <section id="section-upload" className="mt-14 scroll-mt-20">
          <h2 className="text-xl font-semibold text-slate-900">4 · Upload — import documents into the system</h2>
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
            SECTION 5 — ADMIN (in-app user / group management)
            ================================================================== */}
        <section id="section-admin" className="mt-14 scroll-mt-20">
          <h2 className="text-xl font-semibold text-slate-900">5 · Admin — manage users + groups in-app</h2>
          <p className="mt-1 text-sm text-slate-600">
            An app admin (a member of <code>GROUP_APP_ADMINS_ID</code>) can sign in and use{' '}
            <Link href="/admin" className="underline hover:text-slate-900"><code>/admin</code></Link>{' '}
            to do create / read / update / delete on Entra users + Security groups directly,
            without opening the Azure portal.
          </p>

          {/* Walkthrough */}
          <h3 className="mt-6 text-sm font-semibold uppercase tracking-wide text-slate-500">
            How an admin uses the panel
          </h3>
          <ol className="relative mt-3 space-y-3 border-l border-slate-200 pl-6">
            <li className="relative">
              <span className="absolute -left-[2.0625rem] flex h-6 w-6 items-center justify-center rounded-full bg-slate-900 text-xs font-semibold text-white">1</span>
              <div className="text-sm text-slate-700">
                Sign in to <Link href="/login" className="underline hover:text-slate-900"><code>/login</code></Link> as
                a member of <code>GROUP_APP_ADMINS_ID</code>. The chat header shows an
                <strong> Admin</strong> button (only visible to members of that group).
              </div>
            </li>
            <li className="relative">
              <span className="absolute -left-[2.0625rem] flex h-6 w-6 items-center justify-center rounded-full bg-slate-900 text-xs font-semibold text-white">2</span>
              <div className="text-sm text-slate-700">
                Click <strong>Admin</strong> → <code>/admin</code> opens with two tabs:{' '}
                <strong>Users</strong> and <strong>Groups</strong>. Both have list / search /
                detail panels, plus a <strong>↻</strong> refresh on each.
              </div>
            </li>
            <li className="relative">
              <span className="absolute -left-[2.0625rem] flex h-6 w-6 items-center justify-center rounded-full bg-slate-900 text-xs font-semibold text-white">3</span>
              <div className="text-sm text-slate-700">
                <strong>Users tab — full CRUD:</strong>
                <ul className="mt-1 list-disc space-y-0.5 pl-5 text-slate-600">
                  <li><strong>Create</strong>: + New user → UPN, display name, auto-generated password (regen + copy buttons), optional initial group memberships</li>
                  <li><strong>Read</strong>: click any row → detail panel with identity, group memberships, Object ID, deep-link to Azure</li>
                  <li><strong>Update</strong>: Edit → display name / job title / account-enabled toggle (partial PATCH)</li>
                  <li><strong>Delete</strong>: type the UPN to confirm. <em>Refused for users in the admin group</em> + your own account.</li>
                  <li><strong>Reset password</strong>: amber panel, generates new password, you share it securely</li>
                  <li><strong>Add to group</strong> / <strong>× remove</strong>: inline picker on the detail panel</li>
                </ul>
              </div>
            </li>
            <li className="relative">
              <span className="absolute -left-[2.0625rem] flex h-6 w-6 items-center justify-center rounded-full bg-slate-900 text-xs font-semibold text-white">4</span>
              <div className="text-sm text-slate-700">
                <strong>Groups tab — full CRUD on Security groups:</strong>
                <ul className="mt-1 list-disc space-y-0.5 pl-5 text-slate-600">
                  <li><strong>Create</strong>: + New group → name, description (Security type + non-mail forced server-side)</li>
                  <li><strong>Read</strong>: detail panel shows description, member list, Object ID, deep-link</li>
                  <li><strong>Update</strong>: Edit → name + description (partial PATCH; empty description → null on Graph)</li>
                  <li><strong>Delete</strong>: type the group name to confirm. <em>Refused on the admin and uploaders groups</em>.</li>
                  <li><strong>+ Add member</strong> / <strong>× remove</strong>: search-by-UPN picker. Adding to admin group is blocked.</li>
                </ul>
              </div>
            </li>
            <li className="relative">
              <span className="absolute -left-[2.0625rem] flex h-6 w-6 items-center justify-center rounded-full bg-slate-900 text-xs font-semibold text-white">5</span>
              <div className="text-sm text-slate-700">
                Every mutation auto-refreshes both the affected detail panel and the parent list,
                plus a manual <strong>↻ refresh</strong> exists on each surface for stale-data
                situations (changes from another admin session, direct Azure portal edits,
                Graph eventual-consistency lag).
              </div>
            </li>
          </ol>

          {/* Safety guards table */}
          <h3 className="mt-8 text-sm font-semibold uppercase tracking-wide text-slate-500">
            Safety guards (server + UI, defence in depth)
          </h3>
          <div className="mt-3 overflow-x-auto rounded-lg border border-slate-200 bg-white">
            <table className="w-full text-left text-sm">
              <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-4 py-2">Action</th>
                  <th className="px-4 py-2">Where blocked</th>
                  <th className="px-4 py-2">Why</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                <tr>
                  <td className="px-4 py-3 align-top">Delete your own account</td>
                  <td className="px-4 py-3 align-top text-slate-700">Server (400)</td>
                  <td className="px-4 py-3 align-top text-slate-700">Prevent locking yourself out of the panel</td>
                </tr>
                <tr>
                  <td className="px-4 py-3 align-top">Delete a user in the admin group</td>
                  <td className="px-4 py-3 align-top text-slate-700">Server (400) + UI hides Delete + shows <em>Protected · admin user</em></td>
                  <td className="px-4 py-3 align-top text-slate-700">Admin churn is a tenant-level decision; portal-only</td>
                </tr>
                <tr>
                  <td className="px-4 py-3 align-top">Delete the admin group</td>
                  <td className="px-4 py-3 align-top text-slate-700">Server (400) + UI hides Delete + shows <em>Protected</em></td>
                  <td className="px-4 py-3 align-top text-slate-700">Would lock everyone out of <code>/admin</code></td>
                </tr>
                <tr>
                  <td className="px-4 py-3 align-top">Delete the uploaders group</td>
                  <td className="px-4 py-3 align-top text-slate-700">Server (400) + UI hides Delete + shows <em>Protected</em></td>
                  <td className="px-4 py-3 align-top text-slate-700">Would break uploads</td>
                </tr>
                <tr>
                  <td className="px-4 py-3 align-top">Add a user to the admin group</td>
                  <td className="px-4 py-3 align-top text-slate-700">Server (400) + UI hides admin group from picker + shows <em>Manage in Azure portal ↗</em></td>
                  <td className="px-4 py-3 align-top text-slate-700">Stops a compromised admin session from quietly seeding new admins</td>
                </tr>
                <tr>
                  <td className="px-4 py-3 align-top">Remove yourself from the admin group</td>
                  <td className="px-4 py-3 align-top text-slate-700">Server (400)</td>
                  <td className="px-4 py-3 align-top text-slate-700">Same lockout-prevention as self-delete</td>
                </tr>
              </tbody>
            </table>
          </div>

          {/* Prerequisites */}
          <h3 className="mt-8 text-sm font-semibold uppercase tracking-wide text-slate-500">
            Azure prerequisites (one-time, per-tenant)
          </h3>
          <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-4 text-xs text-amber-900">
            <p>
              For the <code>admin@</code> account to actually do anything, three things must be
              set up in Azure (the in-app gate alone is not enough — Graph enforces RBAC + OAuth
              on every write):
            </p>
            <ol className="mt-2 list-decimal space-y-1 pl-5">
              <li>
                <strong>App registration → API permissions (Delegated)</strong>: add{' '}
                <code>User.ReadWrite.All</code>, <code>Group.ReadWrite.All</code>,{' '}
                <code>UserAuthenticationMethod.ReadWrite.All</code> — then click{' '}
                <strong>Grant admin consent for &lt;tenant&gt;</strong>
              </li>
              <li>
                <strong>Entra → Users → admin@ → Assigned roles</strong>: add{' '}
                <strong>User Administrator</strong> (manage users + groups) AND{' '}
                <strong>Privileged Authentication Administrator</strong> (reset passwords on
                modern tenants where the legacy <code>passwordProfile</code> path is blocked)
              </li>
              <li>
                <code>.env.local</code> has <code>GROUP_APP_ADMINS_ID</code> set to the GUID of
                the security group containing <code>admin@</code>
              </li>
            </ol>
            <p className="mt-2">
              The chat&rsquo;s <strong>Admin</strong> link only appears when (1) the OAuth
              scopes are present in the user&rsquo;s token AND (2) the user is in{' '}
              <code>GROUP_APP_ADMINS_ID</code>. Graph then enforces the Entra role on every
              actual write. If a step is missing, the admin sees a 403 with a verbatim Graph
              error explaining which prerequisite isn&rsquo;t in place.
            </p>
          </div>

          {/* Audit */}
          <h3 className="mt-8 text-sm font-semibold uppercase tracking-wide text-slate-500">
            Audit
          </h3>
          <p className="mt-1 text-sm text-slate-600">
            Every admin action writes a structured row to Application Insights with a distinct
            event prefix so the KQL view at §<a href="#section-azure" className="underline hover:text-slate-900">6</a>
            picks it up alongside chat / upload events:
          </p>
          <ul className="mt-2 list-disc space-y-0.5 pl-5 text-xs font-mono text-slate-700">
            <li>[admin:create-user] / [admin:update-user] / [admin:delete-user] / [admin:reset-password]</li>
            <li>[admin:create-group] / [admin:update-group] / [admin:delete-group]</li>
            <li>[admin:add-member] / [admin:remove-member]</li>
          </ul>
          <p className="mt-2 text-xs text-slate-500">
            Password values are NEVER written to the audit row — only the fact that a reset
            happened (with the deleter&rsquo;s identity).
          </p>
        </section>

        {/* ==================================================================
            SECTION 6 — AZURE
            ================================================================== */}
        <section id="section-azure" className="mt-14 scroll-mt-20">
          <h2 className="text-xl font-semibold text-slate-900">6 · How Azure handles everything</h2>
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
