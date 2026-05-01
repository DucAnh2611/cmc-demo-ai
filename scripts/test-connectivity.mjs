#!/usr/bin/env node
// Probe each external service the demo depends on, using values from .env.local.
// Read-only / non-mutating for Search; sends a tiny embedding for AOAI; sends a
// 1-token completion for Anthropic. Prints OK / FAIL / SKIP per service.
//
// Usage:  node scripts/test-connectivity.mjs

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const ENV_FILE = join(ROOT, '.env.local');

function loadEnv() {
  const content = readFileSync(ENV_FILE, 'utf8');
  for (const raw of content.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
}

const C = { g: '\x1b[32m', y: '\x1b[33m', r: '\x1b[31m', b: '\x1b[1m', x: '\x1b[0m' };
const ok   = (m) => console.log(`  ${C.g}OK${C.x}    ${m}`);
const bad  = (m) => console.log(`  ${C.r}FAIL${C.x}  ${m}`);
const skip = (m) => console.log(`  ${C.y}SKIP${C.x}  ${m}`);
const head = (m) => console.log(`\n${C.b}${m}${C.x}`);

function isPlaceholder(v) {
  if (!v) return true;
  return /xxx|<your-|PENDING/i.test(v);
}

function checkLocal() {
  head('Identity (.env.local — no network)');

  const tenant = process.env.NEXT_PUBLIC_AZURE_TENANT_ID;
  const client = process.env.NEXT_PUBLIC_AZURE_CLIENT_ID;
  isPlaceholder(tenant) ? skip(`NEXT_PUBLIC_AZURE_TENANT_ID`)
                        : ok(`NEXT_PUBLIC_AZURE_TENANT_ID=${tenant}`);
  isPlaceholder(client) ? skip(`NEXT_PUBLIC_AZURE_CLIENT_ID (browser MSAL needs this)`)
                        : ok(`NEXT_PUBLIC_AZURE_CLIENT_ID=${client}`);

  for (const k of ['GROUP_HR_ID', 'GROUP_FINANCE_ID', 'GROUP_PUBLIC_ID']) {
    const v = process.env[k];
    isPlaceholder(v) ? skip(`${k} (indexing will use placeholder string instead)`)
                     : ok(`${k}=${v}`);
  }
}

async function testSearch() {
  head('Azure AI Search');
  const endpoint = process.env.AZURE_SEARCH_ENDPOINT;
  const key = process.env.AZURE_SEARCH_API_KEY;
  if (isPlaceholder(endpoint) || isPlaceholder(key)) return skip('not configured');

  const url = `${endpoint.replace(/\/$/, '')}/indexes?api-version=2024-07-01&$select=name`;
  try {
    const r = await fetch(url, { headers: { 'api-key': key } });
    if (!r.ok) {
      const body = (await r.text()).slice(0, 200);
      return bad(`${r.status} ${r.statusText} — ${body}`);
    }
    const data = await r.json();
    const names = (data.value || []).map((x) => x.name);
    ok(`endpoint reachable, admin key valid — ${names.length} index(es): ${names.join(', ') || '(none yet)'}`);
  } catch (e) {
    bad(`network error: ${e.message}`);
  }
}

async function testAOAI() {
  head('Azure OpenAI (embeddings)');
  const endpoint = process.env.AZURE_OPENAI_ENDPOINT;
  const key = process.env.AZURE_OPENAI_API_KEY;
  const deployment = process.env.AZURE_OPENAI_EMBEDDING_DEPLOYMENT || 'text-embedding-3-small';
  const apiVersion = process.env.AZURE_OPENAI_API_VERSION || '2024-02-01';
  if (isPlaceholder(endpoint) || isPlaceholder(key)) return skip('not configured');

  const url = `${endpoint.replace(/\/$/, '')}/openai/deployments/${deployment}/embeddings?api-version=${apiVersion}`;
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'api-key': key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: ['connectivity test'] })
    });
    if (!r.ok) {
      const body = (await r.text()).slice(0, 300);
      return bad(`${r.status} ${r.statusText} — ${body}`);
    }
    const data = await r.json();
    const dim = data?.data?.[0]?.embedding?.length;
    if (!dim) return bad(`unexpected response shape: ${JSON.stringify(data).slice(0, 200)}`);
    ok(`deployment "${deployment}" returned ${dim}-dim vector (api-version ${apiVersion})`);
  } catch (e) {
    bad(`network error: ${e.message}`);
  }
}

async function testAnthropic() {
  head('Anthropic');
  const key = process.env.ANTHROPIC_API_KEY;
  const model = process.env.CLAUDE_MODEL || 'claude-sonnet-4-6';
  if (isPlaceholder(key) || !key.startsWith('sk-ant-')) return skip('not configured');

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model,
        max_tokens: 4,
        messages: [{ role: 'user', content: 'Reply with exactly: ok' }]
      })
    });
    if (!r.ok) {
      const body = (await r.text()).slice(0, 300);
      return bad(`${r.status} ${r.statusText} — ${body}`);
    }
    const data = await r.json();
    const text = data?.content?.[0]?.text || '';
    ok(`model "${model}" reachable — replied: "${text.slice(0, 40)}"`);
  } catch (e) {
    bad(`network error: ${e.message}`);
  }
}

async function testAppInsights() {
  head('Application Insights (optional)');
  const conn = process.env.APPLICATIONINSIGHTS_CONNECTION_STRING;
  if (!conn) return skip('not configured (audit goes to stdout only)');
  const m = /InstrumentationKey=([^;]+)/.exec(conn);
  if (!m) return bad('connection string is malformed (no InstrumentationKey)');
  ok(`connection string present (key ${m[1].slice(0, 8)}…)`);
}

loadEnv();
checkLocal();
await testSearch();
await testAOAI();
await testAnthropic();
await testAppInsights();
console.log('');
