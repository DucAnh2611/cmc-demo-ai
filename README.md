# Claude Secure RAG Demo

Permission-aware Document Q&A using Microsoft Entra ID + Azure AI Search + Claude.

## What this does

Authenticated users (via Entra ID / MSAL) ask questions in a chat UI. The backend resolves the user's group memberships from Microsoft Graph, queries Azure AI Search with a vector + ACL filter so only chunks the user is authorized to read are returned, then sends those chunks to Claude as grounded context. Every query is audit-logged.

ACL filtering happens at the **retrieval layer** — Claude never sees data the end user is not permitted to read.

## Prerequisites

You must have these Azure resources provisioned (see `../secure-rag-demo-guide.md` section 4):

- Microsoft Entra ID app registration (SPA) with API permissions `User.Read`, `GroupMember.Read.All`
- Three security groups: `group-hr-readers`, `group-finance-readers`, `group-public-readers`
- Two demo users (Alice, Bob) added to the appropriate groups
- Azure AI Search service (Basic tier or above)
- Azure OpenAI resource with `text-embedding-3-small` deployment
- Anthropic API key

## Setup

```bash
npm install
cp .env.example .env.local
# fill in all values in .env.local from your Azure resources

# index sample docs (one-time, after .env.local is configured)
npm run index-docs

# run dev server
npm run dev
```

Open `http://localhost:3000` and sign in with one of the demo users.

## Project layout

```
app/
  api/chat/route.ts       Chat endpoint: verify token -> getUserGroups -> secureSearch -> Claude
  login/page.tsx          MSAL sign-in page
  providers/              MsalProvider + AuthGate
  page.tsx                Chat UI with streaming + citations
  layout.tsx
  globals.css
lib/
  auth/
    msalConfig.ts         MSAL browser config
    getUserGroups.ts      Calls Graph /me/transitiveMemberOf, 5-min cache
    verifyToken.ts        Server-side JWT verification (jwks-rsa)
  search/
    embedder.ts           Azure OpenAI embeddings client
    secureSearch.ts       Vector + ACL filter query
  claude/client.ts        Anthropic SDK wrapper
  audit/logger.ts         Audit log to Application Insights or console
  utils/chunker.ts        Simple ~500-token chunker
scripts/
  index-docs.ts           Reads sample-docs/<dept>/*.md, chunks, embeds, uploads
sample-docs/
  hr/                     allowedGroups: GROUP_HR_ID, GROUP_PUBLIC_ID
  finance/                allowedGroups: GROUP_FINANCE_ID, GROUP_PUBLIC_ID
  public/                 allowedGroups: GROUP_PUBLIC_ID
tests/
  secureSearch.test.ts    Vitest: ACL enforcement
```

## Demo scenarios

See `../secure-rag-demo-guide.md` section 7 for the five scenarios (A-E):

- A: same question, two users, different answers based on group membership
- B: boundary refusal when user lacks permission
- C: prompt injection bypass attempt — defeated by retrieval-layer ACL
- D: audit trail query
- E: dynamic permissions — add user to group, effect is immediate

## Scripts

| Command | Action |
|---|---|
| `npm run dev` | Start Next.js dev server on `:3000` |
| `npm run build` | Production build |
| `npm run typecheck` | TypeScript check |
| `npm run index-docs` | Index `sample-docs/` into Azure AI Search |
| `npm test` | Run Vitest ACL enforcement tests |
