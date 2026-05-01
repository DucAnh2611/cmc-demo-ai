// Side-effect module: loads .env.local then .env into process.env.
// Import this BEFORE any module that reads process.env at module-evaluation
// time (e.g. lib/search/embedder.ts, lib/search/secureSearch.ts).
//
// Next.js loads .env.local automatically for the app — this file is only for
// standalone scripts run via tsx / node (e.g. scripts/index-docs.ts).
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { config } from 'dotenv';

const root = process.cwd();
for (const file of ['.env.local', '.env']) {
  const path = resolve(root, file);
  if (existsSync(path)) config({ path });
}
