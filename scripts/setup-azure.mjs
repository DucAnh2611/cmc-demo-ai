#!/usr/bin/env node
// Provision Azure resources for the secure-RAG demo and write values into
// .env.local. Idempotent — safe to re-run; existing resources are reused.
//
// Usage:
//   node scripts/setup-azure.mjs              # all stages
//   node scripts/setup-azure.mjs identity     # Stage A
//   node scripts/setup-azure.mjs search       # Stage B
//   node scripts/setup-azure.mjs openai       # Stage C
//   node scripts/setup-azure.mjs appinsights  # Stage D (optional)
//
// Env overrides:
//   LOCATION=eastus          Region for RG / Search / AppInsights
//   AOAI_LOCATION=eastus     Region for Azure OpenAI
//   DEMO_PASSWORD='...'      Password for Alice + Bob
//
// Prerequisite: az CLI logged in (az login).
// ANTHROPIC_API_KEY is set manually (not an Azure resource).

import { spawnSync } from 'node:child_process';
import {
  copyFileSync, existsSync, readFileSync, unlinkSync, writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const ENV_FILE = join(ROOT, '.env.local');
const ENV_EXAMPLE = join(ROOT, '.env.example');

const RG = 'rg-claude-secure-rag-demo';
const LOCATION = process.env.LOCATION || 'eastus';
const AOAI_LOCATION = process.env.AOAI_LOCATION || 'eastus';
const PASS = process.env.DEMO_PASSWORD || 'Demo!Pass-2026';

// Windows ships az as az.cmd; Node ≥20 requires the .cmd extension when
// shell: false. Other platforms have plain `az`.
const azCmd = process.platform === 'win32' ? 'az.cmd' : 'az';

const C = { g: '\x1b[32m', y: '\x1b[33m', r: '\x1b[31m', b: '\x1b[1m', x: '\x1b[0m' };
const log  = (m) => console.log(`${C.g}[+]${C.x} ${m}`);
const warn = (m) => console.log(`${C.y}[!]${C.x} ${m}`);
const die  = (m) => { console.error(`${C.r}[x]${C.x} ${m}`); process.exit(1); };

function runAz(args, { allowFail = false } = {}) {
  const r = spawnSync(azCmd, args, { encoding: 'utf8', shell: false });
  const out = (r.stdout || '').trim();
  const err = (r.stderr || '').trim();
  if (r.status !== 0) {
    if (allowFail) return { ok: false, out, err };
    const head = args.slice(0, 4).join(' ');
    die(`az ${head}…\n  ${err || out || `exit ${r.status}`}`);
  }
  return { ok: true, out, err };
}

const azGet = (args) => runAz(args).out;
const azTry = (args) => runAz(args, { allowFail: true }).out;

function ensureLogin() {
  const r = runAz(['account', 'show'], { allowFail: true });
  if (!r.ok) die('Not logged in. Run: az login');
}

function ensureEnvFile() {
  if (!existsSync(ENV_FILE)) {
    if (!existsSync(ENV_EXAMPLE)) die(`.env.example not found at ${ENV_EXAMPLE}`);
    copyFileSync(ENV_EXAMPLE, ENV_FILE);
    log('Created .env.local from .env.example');
  }
}

function setEnv(key, value) {
  let content = readFileSync(ENV_FILE, 'utf8');
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^${escapedKey}=.*$`, 'm');
  const line = `${key}=${value}`;
  if (re.test(content)) {
    content = content.replace(re, line);
  } else {
    content = content.replace(/\n*$/, '\n') + line + '\n';
  }
  writeFileSync(ENV_FILE, content);
  log(`${key} set`);
}

// ---------- Stage A: identity ----------

function stageIdentity() {
  log(`${C.b}=== Stage A: identity (RG + app + groups + users) ===${C.x}`);

  const tenantId = azGet(['account', 'show', '--query', 'tenantId', '-o', 'tsv']);
  const tenantDomain = azGet([
    'rest', '--method', 'get',
    '--url', 'https://graph.microsoft.com/v1.0/domains',
    '--query', 'value[?isDefault].id', '-o', 'tsv'
  ]);
  log(`Tenant: ${tenantId}  Domain: ${tenantDomain}`);

  runAz(['group', 'create', '-n', RG, '-l', LOCATION, '-o', 'none']);
  log(`Resource group: ${RG}`);

  // App registration — reuse if present
  let appId = azTry([
    'ad', 'app', 'list', '--display-name', 'claude-rag-demo-spa',
    '--query', '[0].appId', '-o', 'tsv'
  ]);
  if (!appId) {
    appId = azGet([
      'ad', 'app', 'create',
      '--display-name', 'claude-rag-demo-spa',
      '--sign-in-audience', 'AzureADMyOrg',
      '--query', 'appId', '-o', 'tsv'
    ]);
    log(`Created app: ${appId}`);
  } else {
    log(`Reusing app: ${appId}`);
  }

  const appObjId = azGet(['ad', 'app', 'show', '--id', appId, '--query', 'id', '-o', 'tsv']);

  // SPA redirect URI via Graph PATCH (works on older az without --spa-redirect-uris).
  // Body goes through a temp file so we don't fight the Windows shell over JSON braces.
  const bodyPath = join(tmpdir(), `az-spa-${process.pid}-${Date.now()}.json`);
  writeFileSync(bodyPath, JSON.stringify({
    spa: { redirectUris: ['http://localhost:3000'] }
  }));
  try {
    runAz([
      'rest', '--method', 'PATCH',
      '--uri', `https://graph.microsoft.com/v1.0/applications/${appObjId}`,
      '--headers', 'Content-Type=application/json',
      '--body', `@${bodyPath}`
    ]);
    log('SPA redirect URI: http://localhost:3000');
  } finally {
    try { unlinkSync(bodyPath); } catch {}
  }

  // Graph delegated permissions: User.Read + GroupMember.Read.All
  runAz([
    'ad', 'app', 'permission', 'add',
    '--id', appId,
    '--api', '00000003-0000-0000-c000-000000000000',
    '--api-permissions',
    'e1fe6dd8-ba31-4d61-89e7-88639da4683d=Scope',
    'bc024368-1153-4739-b217-4326f2e966d0=Scope',
    '-o', 'none'
  ], { allowFail: true });

  runAz(['ad', 'sp', 'create', '--id', appId, '-o', 'none'], { allowFail: true });

  const consent = runAz(['ad', 'app', 'permission', 'admin-consent', '--id', appId], { allowFail: true });
  if (consent.ok) {
    log('Admin consent granted');
  } else {
    warn('Admin consent failed (need Global Admin). Grant manually:');
    warn('  https://entra.microsoft.com → App registrations → claude-rag-demo-spa → API permissions → Grant admin consent');
  }

  // Groups
  const ensureGroup = (name, nick) => {
    let id = azTry(['ad', 'group', 'list', '--display-name', name, '--query', '[0].id', '-o', 'tsv']);
    if (!id) {
      id = azGet([
        'ad', 'group', 'create',
        '--display-name', name,
        '--mail-nickname', nick,
        '--query', 'id', '-o', 'tsv'
      ]);
    }
    return id;
  };
  const groupHr      = ensureGroup('group-hr-readers',      'grp-hr');
  const groupFinance = ensureGroup('group-finance-readers', 'grp-finance');
  const groupPublic  = ensureGroup('group-public-readers',  'grp-public');
  log(`Groups: HR=${groupHr}  FIN=${groupFinance}  PUB=${groupPublic}`);

  // Users
  const ensureUser = (display, upn) => {
    let id = azTry([
      'ad', 'user', 'list',
      '--filter', `userPrincipalName eq '${upn}'`,
      '--query', '[0].id', '-o', 'tsv'
    ]);
    if (!id) {
      id = azGet([
        'ad', 'user', 'create',
        '--display-name', display,
        '--user-principal-name', upn,
        '--password', PASS,
        '--force-change-password-next-sign-in', 'false',
        '--query', 'id', '-o', 'tsv'
      ]);
      log(`Created ${display}`);
    }
    return id;
  };
  const aliceUpn = `alice@${tenantDomain}`;
  const bobUpn   = `bob@${tenantDomain}`;
  const aliceId  = ensureUser('Alice', aliceUpn);
  const bobId    = ensureUser('Bob',   bobUpn);

  const addMember = (groupId, memberId) =>
    runAz(['ad', 'group', 'member', 'add', '--group', groupId, '--member-id', memberId, '-o', 'none'],
          { allowFail: true });
  addMember(groupHr,      aliceId);
  addMember(groupPublic,  aliceId);
  addMember(groupFinance, bobId);
  addMember(groupPublic,  bobId);

  setEnv('NEXT_PUBLIC_AZURE_TENANT_ID', tenantId);
  setEnv('NEXT_PUBLIC_AZURE_CLIENT_ID', appId);
  setEnv('AZURE_API_AUDIENCE',          appId);
  setEnv('GROUP_HR_ID',                 groupHr);
  setEnv('GROUP_FINANCE_ID',            groupFinance);
  setEnv('GROUP_PUBLIC_ID',             groupPublic);

  console.log('');
  log('Stage A complete. Demo accounts:');
  console.log(`    ${aliceUpn}  password: ${PASS}`);
  console.log(`    ${bobUpn}    password: ${PASS}`);
  console.log('');
}

// ---------- Stage B: Azure AI Search ----------

function stageSearch() {
  log(`${C.b}=== Stage B: Azure AI Search ===${C.x}`);

  let searchName = azTry([
    'search', 'service', 'list', '-g', RG,
    '--query', "[?contains(name, 'cmc-rag-search')].name | [0]",
    '-o', 'tsv'
  ]);

  if (searchName) {
    log(`Reusing service: ${searchName}`);
  } else {
    searchName = `cmc-rag-search-${Math.floor(Math.random() * 100000)}`;
    log(`Creating service: ${searchName} (~3 min)`);
    runAz([
      'search', 'service', 'create',
      '-g', RG, '-n', searchName,
      '--sku', 'basic', '--location', LOCATION
    ]);
  }

  const searchKey = azGet([
    'search', 'admin-key', 'show',
    '-g', RG, '--service-name', searchName,
    '--query', 'primaryKey', '-o', 'tsv'
  ]);

  setEnv('AZURE_SEARCH_ENDPOINT',   `https://${searchName}.search.windows.net`);
  setEnv('AZURE_SEARCH_API_KEY',    searchKey);
  setEnv('AZURE_SEARCH_INDEX_NAME', 'secure-docs-index');

  console.log('');
  log('Stage B complete\n');
}

// ---------- Stage C: Azure OpenAI ----------

function stageOpenAI() {
  log(`${C.b}=== Stage C: Azure OpenAI + text-embedding-3-small ===${C.x}`);

  runAz(['provider', 'register', '--namespace', 'Microsoft.CognitiveServices', '--wait'], { allowFail: true });

  let aoaiName = azTry([
    'cognitiveservices', 'account', 'list', '-g', RG,
    '--query', "[?kind=='OpenAI'].name | [0]", '-o', 'tsv'
  ]);

  if (aoaiName) {
    log(`Reusing AOAI: ${aoaiName}`);
  } else {
    aoaiName = `cmc-rag-aoai-${Math.floor(Math.random() * 100000)}`;
    log(`Creating AOAI: ${aoaiName}`);
    const r = runAz([
      'cognitiveservices', 'account', 'create',
      '-g', RG, '-n', aoaiName,
      '--kind', 'OpenAI', '--sku', 'S0',
      '--location', AOAI_LOCATION,
      '--custom-domain', aoaiName,
      '--yes'
    ], { allowFail: true });
    if (!r.ok) {
      die(`AOAI create failed:\n  ${r.err}\n` +
          `Subscription may need quota approval — see https://aka.ms/oai/access`);
    }
  }

  const hasDeploy = azTry([
    'cognitiveservices', 'account', 'deployment', 'list',
    '-g', RG, '-n', aoaiName,
    '--query', "[?name=='text-embedding-3-small'].name | [0]", '-o', 'tsv'
  ]);

  if (!hasDeploy) {
    log('Deploying text-embedding-3-small');
    runAz([
      'cognitiveservices', 'account', 'deployment', 'create',
      '-g', RG, '-n', aoaiName,
      '--deployment-name', 'text-embedding-3-small',
      '--model-name', 'text-embedding-3-small',
      '--model-version', '1',
      '--model-format', 'OpenAI',
      '--sku-capacity', '50', '--sku-name', 'Standard'
    ]);
  } else {
    log('Deployment text-embedding-3-small already exists');
  }

  const aoaiKey = azGet([
    'cognitiveservices', 'account', 'keys', 'list',
    '-g', RG, '-n', aoaiName,
    '--query', 'key1', '-o', 'tsv'
  ]);
  const aoaiEndpoint = azGet([
    'cognitiveservices', 'account', 'show',
    '-g', RG, '-n', aoaiName,
    '--query', 'properties.endpoint', '-o', 'tsv'
  ]);

  setEnv('AZURE_OPENAI_ENDPOINT',             aoaiEndpoint);
  setEnv('AZURE_OPENAI_API_KEY',              aoaiKey);
  setEnv('AZURE_OPENAI_EMBEDDING_DEPLOYMENT', 'text-embedding-3-small');
  setEnv('AZURE_OPENAI_API_VERSION',          '2024-02-01');

  console.log('');
  log('Stage C complete\n');
}

// ---------- Stage D: Application Insights ----------

function stageAppInsights() {
  log(`${C.b}=== Stage D: Application Insights (optional) ===${C.x}`);

  const lawName = 'cmc-rag-law';
  const aiName  = 'cmc-rag-appinsights';

  const lawExists = azTry([
    'monitor', 'log-analytics', 'workspace', 'show',
    '-g', RG, '-n', lawName, '--query', 'name', '-o', 'tsv'
  ]);
  if (!lawExists) {
    log(`Creating Log Analytics workspace: ${lawName}`);
    runAz(['monitor', 'log-analytics', 'workspace', 'create', '-g', RG, '-n', lawName, '-l', LOCATION]);
  }
  const lawId = azGet([
    'monitor', 'log-analytics', 'workspace', 'show',
    '-g', RG, '-n', lawName, '--query', 'id', '-o', 'tsv'
  ]);

  runAz(['extension', 'add', '--name', 'application-insights', '--upgrade'], { allowFail: true });

  const aiExists = azTry([
    'monitor', 'app-insights', 'component', 'show',
    '-g', RG, '-a', aiName, '--query', 'name', '-o', 'tsv'
  ]);
  if (!aiExists) {
    log(`Creating Application Insights: ${aiName}`);
    runAz([
      'monitor', 'app-insights', 'component', 'create',
      '-g', RG, '-a', aiName, '-l', LOCATION,
      '--workspace', lawId,
      '--kind', 'web', '--application-type', 'web'
    ]);
  }

  const aiConn = azGet([
    'monitor', 'app-insights', 'component', 'show',
    '-g', RG, '-a', aiName,
    '--query', 'connectionString', '-o', 'tsv'
  ]);
  setEnv('APPLICATIONINSIGHTS_CONNECTION_STRING', aiConn);

  console.log('');
  log('Stage D complete\n');
}

// ---------- status ----------

function showStatus() {
  log('Pending values in .env.local:');
  const lines = readFileSync(ENV_FILE, 'utf8').split('\n');
  const pending = lines
    .map((line, i) => ({ line, i: i + 1 }))
    .filter(({ line }) =>
      !line.startsWith('#') && /(=PENDING|=sk-ant-xxx|=$|=xxx$|=xxx[^a-zA-Z0-9])/.test(line)
    );
  if (pending.length === 0) {
    console.log('    (none — all values set)');
  } else {
    for (const { line, i } of pending) console.log(`    ${i}: ${line}`);
  }
  console.log('');
  warn(`Don't forget to set ANTHROPIC_API_KEY manually:`);
  console.log('    1. https://console.anthropic.com → Settings → API Keys → Create Key');
  console.log('    2. Edit .env.local: ANTHROPIC_API_KEY=sk-ant-...');
}

// ---------- main ----------

function printHelp() {
  console.log(`Usage: node scripts/setup-azure.mjs [stage]

  Provisions Azure resources for the secure-RAG demo and writes values into
  .env.local. Idempotent — safe to re-run.

  Stages:
    identity     Stage A — RG + Entra app + groups + demo users
    search       Stage B — Azure AI Search service
    openai       Stage C — Azure OpenAI + text-embedding-3-small deployment
    appinsights  Stage D — Application Insights (optional, for Scenario D)
    all          (default) all four stages in order

  Env overrides:
    LOCATION=eastus           Region for RG / Search / AppInsights
    AOAI_LOCATION=eastus      Region for Azure OpenAI
    DEMO_PASSWORD='...'       Password for Alice + Bob

  Prerequisite: az CLI logged in (run: az login).
  ANTHROPIC_API_KEY is set manually (not an Azure resource).
`);
}

function main() {
  const arg = process.argv[2] || 'all';
  if (['-h', '--help', 'help'].includes(arg)) {
    printHelp();
    return;
  }

  ensureLogin();
  ensureEnvFile();

  switch (arg) {
    case 'A': case 'identity':                  stageIdentity(); break;
    case 'B': case 'search':                    stageSearch(); break;
    case 'C': case 'openai':  case 'aoai':      stageOpenAI(); break;
    case 'D': case 'appinsights': case 'ai':    stageAppInsights(); break;
    case 'all':
      stageIdentity();
      stageSearch();
      stageOpenAI();
      stageAppInsights();
      break;
    default:
      die(`Unknown stage: ${arg}\n  Use one of: identity | search | openai | appinsights | all`);
  }

  showStatus();
}

main();
