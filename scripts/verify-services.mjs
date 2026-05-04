#!/usr/bin/env node
//
// Verify every external service the demo depends on, using values loaded
// from a dotenv-style file. Each service section shows every env var it
// reads ON ITS OWN LINE (with the value, masked when secret), then
// performs a non-mutating live probe when the essentials are present.
//
// Independence guarantee:
//   - Each env var is checked independently. A missing/placeholder/bad
//     value for one key does NOT short-circuit checks of other keys in
//     the same block.
//   - Each probe block is wrapped in a top-level try/catch — an unexpected
//     throw in one section does NOT prevent later sections from running.
//
// Usage:
//   node scripts/verify-services.mjs
//   node scripts/verify-services.mjs --envPath=.env.local
//   node scripts/verify-services.mjs --envPath=.env.staging
//   node scripts/verify-services.mjs --envPath=/abs/path/to/file
//
// Exit code:
//   0 — all OK or SKIP (skipped == intentionally not configured)
//   1 — at least one FAIL (configured but unreachable / wrong creds)
//

import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, isAbsolute, resolve } from 'node:path';

// ---------- CLI args ----------

/** Parse `--envPath=value` and `--envPath value` forms. Unknown args ignored. */
function parseArgs(argv) {
  const opts = { envPath: '.env.local', help: false };
  const args = argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--help' || a === '-h') {
      opts.help = true;
      continue;
    }
    const eq = /^--([\w-]+)=(.*)$/.exec(a);
    if (eq) {
      if (eq[1] === 'envPath') opts.envPath = eq[2];
      continue;
    }
    const flag = /^--([\w-]+)$/.exec(a);
    if (flag && flag[1] === 'envPath' && i + 1 < args.length) {
      opts.envPath = args[++i];
    }
  }
  return opts;
}

const opts = parseArgs(process.argv);

if (opts.help) {
  console.log(`Usage: node scripts/verify-services.mjs [--envPath=.env.local]

Verifies each external service the demo depends on.

Options:
  --envPath <path>   dotenv file to load (default: .env.local)
  -h, --help         show this help

Exit codes:
  0   no failures (some keys may be skipped if intentionally unconfigured)
  1   at least one configured key/service failed its probe`);
  process.exit(0);
}

// ---------- Load env file ----------

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const envPath = isAbsolute(opts.envPath) ? opts.envPath : resolve(ROOT, opts.envPath);

let loadedCount = 0;
try {
  const content = readFileSync(envPath, 'utf8');
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line);
    if (!m) continue;
    let val = m[2];
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (process.env[m[1]] === undefined) {
      process.env[m[1]] = val;
      loadedCount++;
    }
  }
} catch (e) {
  console.error(`\x1b[31mCannot read env file: ${envPath}\x1b[0m`);
  console.error(`  (${e.message})`);
  process.exit(1);
}

// ---------- Output helpers ----------

const C = {
  g: '\x1b[32m',
  y: '\x1b[33m',
  r: '\x1b[31m',
  b: '\x1b[1m',
  dim: '\x1b[2m',
  x: '\x1b[0m'
};

const counters = { ok: 0, fail: 0, skip: 0 };
const head = (m) => console.log(`\n${C.b}${m}${C.x}`);
const ok = (m) => {
  counters.ok++;
  console.log(`  ${C.g}OK${C.x}    ${m}`);
};
const bad = (m) => {
  counters.fail++;
  console.log(`  ${C.r}FAIL${C.x}  ${m}`);
};
const skip = (m) => {
  counters.skip++;
  console.log(`  ${C.y}SKIP${C.x}  ${m}`);
};
const note = (m) => console.log(`        ${C.dim}${m}${C.x}`);

/** True when a value is missing or looks like an unfilled placeholder. */
function isPlaceholder(v) {
  if (!v) return true;
  return /^xxx$|^sk-ant-xxx$|<your-|PENDING/i.test(v);
}

/** Mask a secret for stdout. Keeps enough prefix/suffix to identify which
 *  rotation the value belongs to without exposing the secret on a screen
 *  share / pasted log. Format: `prefix8…suffix4` for long values. */
function maskSecret(v) {
  if (!v) return '';
  if (v.length <= 12) return `${v.slice(0, 4)}…`;
  return `${v.slice(0, 8)}…${v.slice(-4)}`;
}

/**
 * Check a single env var and emit one OK / SKIP line with its value.
 * `kind` controls value display:
 *   - 'public' (default): full value shown — for endpoints, model names,
 *     deployment names, GUIDs that are not really secret.
 *   - 'secret': value masked via maskSecret() — for API keys + connection
 *     strings (anything that grants access).
 *
 * `defaultVal`, when supplied, is shown in the SKIP message for vars that
 * have an in-code default — clarifies that "missing" is fine and what the
 * runtime will use instead.
 */
function checkEnv(name, kind = 'public', defaultVal) {
  const v = process.env[name];
  if (v === undefined || v === '') {
    if (defaultVal !== undefined) {
      skip(`${name} = (not set) — runtime default: "${defaultVal}"`);
    } else {
      skip(`${name} = (not set)`);
    }
    return;
  }
  if (isPlaceholder(v)) {
    skip(`${name} = "${v}" (placeholder)`);
    return;
  }
  const display = kind === 'secret' ? maskSecret(v) : v;
  ok(`${name} = ${display}`);
}

// ---------- Live probes (run only when essentials present, wrapped in try/catch) ----------

async function liveProbeIdentity() {
  const tenant = process.env.NEXT_PUBLIC_AZURE_TENANT_ID;
  if (isPlaceholder(tenant)) {
    skip('live: tenant discovery — NEXT_PUBLIC_AZURE_TENANT_ID required');
    return;
  }
  // OIDC discovery doc is anonymous + cheap — proves the tenant ID resolves.
  const url = `https://login.microsoftonline.com/${tenant}/v2.0/.well-known/openid-configuration`;
  try {
    const r = await fetch(url);
    if (!r.ok) bad(`live: tenant discovery returned ${r.status} for tenant ${tenant}`);
    else ok(`live: tenant discovery 200 OK`);
  } catch (e) {
    bad(`live: tenant discovery network error: ${e.message}`);
  }
}

async function liveProbeSearch() {
  const endpoint = process.env.AZURE_SEARCH_ENDPOINT;
  const key = process.env.AZURE_SEARCH_API_KEY;
  const indexName = process.env.AZURE_SEARCH_INDEX_NAME || 'secure-docs-index';
  if (isPlaceholder(endpoint) || isPlaceholder(key)) {
    skip('live: list-indexes — endpoint + key required');
    return;
  }
  const url = `${endpoint.replace(/\/$/, '')}/indexes?api-version=2024-07-01&$select=name`;
  try {
    const r = await fetch(url, { headers: { 'api-key': key } });
    if (!r.ok) {
      const body = (await r.text()).slice(0, 200);
      bad(`live: list-indexes ${r.status} ${r.statusText} — ${body}`);
      return;
    }
    const data = await r.json();
    const names = (data.value || []).map((x) => x.name);
    ok(`live: list-indexes — ${names.length} index(es): ${names.join(', ') || '(none)'}`);
    if (!names.includes(indexName)) {
      note(`index "${indexName}" NOT found — run "npm run index-docs" to create + populate it`);
    }
  } catch (e) {
    bad(`live: list-indexes network error: ${e.message}`);
  }
}

async function liveProbeAOAI() {
  const endpoint = process.env.AZURE_OPENAI_ENDPOINT;
  const key = process.env.AZURE_OPENAI_API_KEY;
  const deployment = process.env.AZURE_OPENAI_EMBEDDING_DEPLOYMENT || 'text-embedding-3-small';
  const apiVersion = process.env.AZURE_OPENAI_API_VERSION || '2024-02-01';
  if (isPlaceholder(endpoint) || isPlaceholder(key)) {
    skip('live: embeddings — endpoint + key required');
    return;
  }
  const url = `${endpoint.replace(/\/$/, '')}/openai/deployments/${deployment}/embeddings?api-version=${apiVersion}`;
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'api-key': key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: ['connectivity test'] })
    });
    if (!r.ok) {
      const body = (await r.text()).slice(0, 300);
      bad(`live: embeddings ${r.status} ${r.statusText} — ${body}`);
      return;
    }
    const data = await r.json();
    const dim = data?.data?.[0]?.embedding?.length;
    if (!dim) bad(`live: embeddings unexpected response shape`);
    else ok(`live: embeddings — deployment "${deployment}" returned ${dim}-dim vector`);
  } catch (e) {
    bad(`live: embeddings network error: ${e.message}`);
  }
}

async function liveProbeAnthropic() {
  const key = process.env.ANTHROPIC_API_KEY;
  const model = process.env.CLAUDE_MODEL || 'claude-sonnet-4-6';
  if (isPlaceholder(key) || !key.startsWith('sk-ant-')) {
    skip('live: Claude completion — ANTHROPIC_API_KEY required');
    return;
  }
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
      bad(`live: Claude completion ${r.status} ${r.statusText} — ${body}`);
      return;
    }
    const data = await r.json();
    const text = (data?.content?.[0]?.text || '').replace(/\n/g, ' ').slice(0, 40);
    ok(`live: Claude completion — model "${model}" replied: "${text}"`);
  } catch (e) {
    bad(`live: Claude completion network error: ${e.message}`);
  }
}

async function liveProbeBlob() {
  const conn = process.env.AZURE_STORAGE_CONNECTION_STRING;
  const containerName = process.env.AZURE_STORAGE_CONTAINER || 'uploads';
  if (!conn) {
    skip('live: blob getProperties — AZURE_STORAGE_CONNECTION_STRING required');
    return;
  }
  const parts = Object.fromEntries(
    conn
      .split(';')
      .filter(Boolean)
      .map((p) => {
        const i = p.indexOf('=');
        return i === -1 ? [p, ''] : [p.slice(0, i), p.slice(i + 1)];
      })
  );
  const account = parts.AccountName;
  const suffix = parts.EndpointSuffix || 'core.windows.net';
  if (!account) {
    bad('live: blob — connection string missing AccountName');
    return;
  }
  let mod;
  try {
    mod = await import('@azure/storage-blob');
  } catch {
    skip('live: blob — @azure/storage-blob not installed (run "npm install")');
    return;
  }
  try {
    const svc = mod.BlobServiceClient.fromConnectionString(conn);
    // getProperties() exercises the SharedKey signing path against the
    // account endpoint — proves the AccountName + AccountKey are valid.
    await svc.getProperties();
    ok(`live: blob getProperties — account "${account}.blob.${suffix}" reachable, key valid`);
    const cc = svc.getContainerClient(containerName);
    const exists = await cc.exists();
    if (exists) note(`container "${containerName}" exists`);
    else note(`container "${containerName}" does NOT exist — first upload will create it`);
  } catch (e) {
    bad(`live: blob auth/probe failed: ${e.message}`);
  }
}

// ---------- Azure resource tier + spend probe (via `az` CLI) ----------

/**
 * Run an `az` CLI command and return trimmed stdout, or null on any failure
 * (CLI not installed, not logged in, command rejected, no permission).
 * Always fail-soft — the rest of the script must keep working without `az`.
 */
function runAz(args) {
  try {
    return execSync(`az ${args}`, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer: 8 * 1024 * 1024
    }).trim();
  } catch {
    return null;
  }
}

/** Parse JSON output from `az`, returning null instead of throwing. */
function tryParseJson(s) {
  if (!s || s === 'null') return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

/** Extract `<name>` from `https://<name>.something.azure.com/...` style URLs. */
function hostnameLeftLabel(url) {
  try {
    const u = new URL(url);
    const parts = u.hostname.split('.');
    return parts[0] || null;
  } catch {
    return null;
  }
}

/** Extract AccountName=… from a storage connection string. */
function storageAccountFromConn(conn) {
  if (!conn) return null;
  const m = /AccountName=([^;]+)/.exec(conn);
  return m ? m[1] : null;
}

/** Pretty-print a tier so the cost implication is visible at a glance. */
function searchTierNote(skuName) {
  const t = (skuName || '').toLowerCase();
  if (t === 'free') return 'Free (F0) — $0/mo · 50 MB · 3 indexes max';
  if (t === 'basic') return 'Basic — ~$75/mo · 2 GB · vector search supported';
  if (t.startsWith('standard')) return `${skuName} — paid tier, see https://azure.microsoft.com/pricing/details/search/`;
  return skuName;
}

async function probeAzureTiers() {
  // ----- gate on az availability -----
  const azVer = runAz('--version');
  if (!azVer) {
    skip('az CLI not found in PATH — install: https://learn.microsoft.com/cli/azure/install-azure-cli');
    return;
  }

  // ----- subscription identity -----
  const subRaw = runAz('account show -o json');
  const sub = tryParseJson(subRaw);
  if (!sub) {
    skip('not logged in — run `az login`, then re-run this script');
    return;
  }
  ok(`subscription: "${sub.name}" (${sub.id}) — state: ${sub.state}`);
  if (sub.user?.name) note(`signed in as: ${sub.user.name}`);
  // List other subscriptions this account can see — useful when the
  // demo resources live in a different sub (common in enterprise
  // setups where the dev signs in with a personal account but the
  // resources are on a corporate tenant).
  const allSubsRaw = runAz('account list --query "[].{name:name, id:id, isDefault:isDefault}" -o json');
  const allSubs = tryParseJson(allSubsRaw);
  if (Array.isArray(allSubs) && allSubs.length > 1) {
    note(`other subscriptions visible to this account (${allSubs.length - 1}):`);
    for (const s of allSubs) {
      if (s.id !== sub.id) note(`  ${s.name} (${s.id}) — switch: az account set --subscription ${s.id}`);
    }
  }

  // ----- Search service tier -----
  const searchEndpoint = process.env.AZURE_SEARCH_ENDPOINT;
  const searchName = hostnameLeftLabel(searchEndpoint);
  if (!searchName) {
    skip('AZURE_SEARCH_ENDPOINT missing or malformed — cannot resolve Search resource name');
  } else {
    // Cross-subscription list filter — finds the resource without us
    // needing to know its resource group.
    const raw = runAz(
      `search service list --query "[?name=='${searchName}'] | [0].{rg:resourceGroup, sku:sku.name, replicas:replicaCount, partitions:partitionCount, location:location}" -o json`
    );
    const data = tryParseJson(raw);
    if (data) {
      ok(
        `Search "${searchName}" — tier: ${(data.sku || 'unknown').toUpperCase()}` +
          ` · rg: ${data.rg} · ${data.replicas}×${data.partitions} (replicas×partitions) · ${data.location}`
      );
      note(searchTierNote(data.sku));
    } else {
      skip(`Search "${searchName}" not in current subscription — data-plane key works but az has no Reader role here. Switch subscriptions or run: az role assignment create --role Reader --assignee <upn> --scope /subscriptions/<sub>/resourceGroups/<rg>/providers/Microsoft.Search/searchServices/${searchName}`);
    }
  }

  // ----- Storage account SKU + access tier -----
  const blobConn = process.env.AZURE_STORAGE_CONNECTION_STRING;
  const storageName = storageAccountFromConn(blobConn);
  if (!storageName) {
    skip('AZURE_STORAGE_CONNECTION_STRING missing or malformed — cannot resolve Storage account name');
  } else {
    const raw = runAz(
      `storage account list --query "[?name=='${storageName}'] | [0].{rg:resourceGroup, sku:sku.name, kind:kind, accessTier:accessTier, location:location}" -o json`
    );
    const data = tryParseJson(raw);
    if (data) {
      ok(
        `Storage "${storageName}" — ${data.kind}/${data.sku}/${data.accessTier || 'no-access-tier'}` +
          ` · rg: ${data.rg} · ${data.location}`
      );
      note('LRS = locally redundant (cheapest); GRS = geo-redundant. Hot = fastest reads, Cool = cheaper for cold data');
    } else {
      skip(`Storage "${storageName}" not in current subscription — likely lives in a different sub. Connection string still works (it carries its own AccountKey).`);
    }
  }

  // ----- Azure OpenAI SKU + per-deployment SKU -----
  const aoaiEndpoint = process.env.AZURE_OPENAI_ENDPOINT;
  const aoaiName = hostnameLeftLabel(aoaiEndpoint);
  if (!aoaiName) {
    skip('AZURE_OPENAI_ENDPOINT missing or malformed — cannot resolve OpenAI resource name');
  } else {
    const raw = runAz(
      `cognitiveservices account list --query "[?name=='${aoaiName}'] | [0].{rg:resourceGroup, sku:sku.name, kind:kind, location:location}" -o json`
    );
    const data = tryParseJson(raw);
    if (data) {
      ok(
        `OpenAI "${aoaiName}" — ${data.kind}/${data.sku}` +
          ` · rg: ${data.rg} · ${data.location}`
      );
      // Per-deployment SKU + capacity (Standard = pay-per-token, ProvisionedManaged = reserved PTU).
      const depsRaw = runAz(
        `cognitiveservices account deployment list -g "${data.rg}" -n "${aoaiName}" --query "[].{name:name, model:properties.model.name, sku:sku.name, capacity:sku.capacity}" -o json`
      );
      const deps = tryParseJson(depsRaw);
      if (Array.isArray(deps) && deps.length > 0) {
        for (const d of deps) {
          note(
            `deployment "${d.name}" → model: ${d.model} · sku: ${d.sku} · capacity: ${d.capacity ?? '?'}K TPM`
          );
        }
      } else {
        note('no deployments visible');
      }
    } else {
      skip(`OpenAI "${aoaiName}" not in current subscription — likely lives in a different sub. Data-plane API key still works.`);
    }
  }

  // ----- last-7-days consumption (the actual "did I owe money" answer) -----
  const today = new Date().toISOString().slice(0, 10);
  const weekAgo = new Date(Date.now() - 7 * 86400 * 1000).toISOString().slice(0, 10);
  const usageRaw = runAz(
    `consumption usage list --start-date ${weekAgo} --end-date ${today} --query "[].{service:meterDetails.serviceName, cost:pretaxCost, currency:currency}" -o json`
  );
  const usage = tryParseJson(usageRaw);
  if (Array.isArray(usage)) {
    if (usage.length === 0) {
      ok(`last 7 days consumption in subscription "${sub.name}": 0.00`);
      note('zero cost in THIS subscription. If the demo resources above showed SKIP for tier checks, costs are billed against the OTHER subscription that owns them — switch with `az account set --subscription <id>` and re-run.');
      note('other plausible causes: free tier, free credits absorbing usage, 24-48h billing latency');
    } else {
      const byService = new Map();
      let currency = '?';
      for (const u of usage) {
        const svc = u.service || 'unknown';
        const cost = Number(u.cost || 0);
        byService.set(svc, (byService.get(svc) || 0) + cost);
        if (u.currency) currency = u.currency;
      }
      const total = Array.from(byService.values()).reduce((a, b) => a + b, 0);
      ok(`last 7 days consumption: ${total.toFixed(4)} ${currency} across ${byService.size} service(s)`);
      const top = [...byService.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
      for (const [svc, c] of top) {
        note(`  ${svc}: ${c.toFixed(4)} ${currency}`);
      }
    }
  } else {
    skip('consumption usage query failed — likely missing Billing Reader role on the subscription');
    note('not fatal: you can still inspect costs via Portal → Cost Management → Cost analysis');
  }
}

// ---------- Section blocks (env vars + live probe) ----------

const sections = [
  {
    title: '1. Microsoft Entra ID (identity)',
    vars: () => {
      checkEnv('NEXT_PUBLIC_AZURE_TENANT_ID');
      checkEnv('NEXT_PUBLIC_AZURE_CLIENT_ID');
      checkEnv('AZURE_API_AUDIENCE');
    },
    live: liveProbeIdentity
  },
  {
    title: '2. Demo group IDs (consumed by /api/upload + indexer)',
    vars: () => {
      checkEnv('GROUP_HR_ID');
      checkEnv('GROUP_FINANCE_ID');
      checkEnv('GROUP_PUBLIC_ID');
      checkEnv('GROUP_UPLOADERS_ID', 'public', '(unset = any authenticated user can upload)');
    }
    // No live probe — group IDs are validated by /api/upload at runtime.
  },
  {
    title: '3. Azure AI Search',
    vars: () => {
      checkEnv('AZURE_SEARCH_ENDPOINT');
      checkEnv('AZURE_SEARCH_API_KEY', 'secret');
      checkEnv('AZURE_SEARCH_INDEX_NAME', 'public', 'secure-docs-index');
    },
    live: liveProbeSearch
  },
  {
    title: '4. Azure OpenAI (embeddings)',
    vars: () => {
      checkEnv('AZURE_OPENAI_ENDPOINT');
      checkEnv('AZURE_OPENAI_API_KEY', 'secret');
      checkEnv('AZURE_OPENAI_EMBEDDING_DEPLOYMENT', 'public', 'text-embedding-3-small');
      checkEnv('AZURE_OPENAI_API_VERSION', 'public', '2024-02-01');
    },
    live: liveProbeAOAI
  },
  {
    title: '5. Anthropic API (Claude)',
    vars: () => {
      checkEnv('ANTHROPIC_API_KEY', 'secret');
      checkEnv('CLAUDE_MODEL', 'public', 'claude-sonnet-4-6');
      checkEnv('CLAUDE_EXPANSION_MODEL', 'public', 'falls back to CLAUDE_MODEL');
    },
    live: liveProbeAnthropic
  },
  {
    title: '6. Azure Blob Storage (uploads)',
    vars: () => {
      checkEnv('AZURE_STORAGE_CONNECTION_STRING', 'secret');
      checkEnv('AZURE_STORAGE_CONTAINER', 'public', 'uploads');
    },
    live: liveProbeBlob
  },
  {
    title: '7. Application Insights (optional audit sink)',
    vars: () => {
      checkEnv('APPLICATIONINSIGHTS_CONNECTION_STRING', 'secret');
    }
    // No live probe — telemetry ingestion is fire-and-forget; verified
    // when the running app emits its first trace.
  },
  {
    // Reads NO env vars — uses `az` CLI auth context. Listed here so it
    // runs in the same loop and reports through the same OK/SKIP/FAIL
    // counters. Resource names are derived from the endpoint env vars
    // already loaded above (Search/Storage/OpenAI), no separate config.
    title: '8. Azure resource tiers + recent spend (requires `az` CLI)',
    vars: () => {
      // No env vars to print here — derived from earlier sections.
    },
    live: probeAzureTiers
  }
];

// ---------- Run ----------

console.log(`${C.b}Verifying services from ${envPath}${C.x}`);
console.log(`${C.dim}Loaded ${loadedCount} env var${loadedCount === 1 ? '' : 's'} from file${C.x}`);

for (const section of sections) {
  head(section.title);

  // Env-var checks. checkEnv() does its own try-free work (pure read +
  // print), so a malformed value can't throw here. Each var emits exactly
  // one OK/SKIP line — no var blocks any other.
  try {
    section.vars();
  } catch (e) {
    bad(`section vars threw unexpectedly: ${e.message}`);
  }

  // Live probe (when defined). Wrapped in try/catch so a network glitch
  // or SDK exception in one section never aborts the script — subsequent
  // sections still run and the summary still prints.
  if (section.live) {
    try {
      await section.live();
    } catch (e) {
      bad(`live probe threw unexpectedly: ${e.message}`);
    }
  }
}

console.log(
  `\n${C.b}Summary:${C.x} ${C.g}${counters.ok} OK${C.x}, ${C.r}${counters.fail} FAIL${C.x}, ${C.y}${counters.skip} SKIP${C.x}\n`
);

process.exit(counters.fail > 0 ? 1 : 0);
