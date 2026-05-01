// Side-effect module. Import from every server-only entry point that handles
// secrets (chat/route, source/route, indexing script). Throws at module-load
// time if a sensitive env var is mis-prefixed with NEXT_PUBLIC_ — that prefix
// causes Next.js to inline the value into the browser bundle, where any
// site visitor could read it from DevTools.
//
// This guards against guideline §"Sharing Search admin key with the browser"
// regressing in a future PR.
//
// Note: we intentionally don't `import 'server-only'` here. That helper
// short-circuits in any non-server-component context (vitest included), so
// it would force every test to also configure the `react-server` resolve
// condition. Our own NEXT_PUBLIC_ check is the actual safeguard either way.

const NEVER_PUBLIC = [
  'AZURE_SEARCH_API_KEY',
  'AZURE_OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'APPLICATIONINSIGHTS_CONNECTION_STRING',
  'AZURE_STORAGE_CONNECTION_STRING'
] as const;

for (const name of NEVER_PUBLIC) {
  if (process.env[`NEXT_PUBLIC_${name}`]) {
    throw new Error(
      `[envGuard] NEXT_PUBLIC_${name} is set — that prefix inlines the value ` +
        `into the client bundle. Rename it to ${name} (server-only).`
    );
  }
}

// Make this file a TypeScript module (not a global script) so it can be
// imported with the dynamic-import form used in the tripwire tests.
export {};
