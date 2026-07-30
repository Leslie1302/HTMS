#!/usr/bin/env node
/**
 * CI gate: migration filenames must be `NNNN[suffix]_description.sql` with a unique
 * prefix. A duplicate number means two migrations race for the same slot and the
 * applied order becomes guesswork — see the 0009 pair in this folder.
 */
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'supabase', 'migrations');
const files = readdirSync(dir).filter((f) => f.endsWith('.sql'));

const errors = [];
const seen = new Map();
// Known historical duplicate, already applied in production — do not renumber.
const GRANDFATHERED = new Set(['0009', '0009b']);

for (const f of files.sort()) {
  const m = /^(\d{4}[a-z]?)_[a-z0-9_]+\.sql$/.exec(f);
  if (!m) {
    errors.push(`${f}: expected NNNN[a-z]_snake_case_description.sql`);
    continue;
  }
  const prefix = m[1];
  if (seen.has(prefix)) {
    errors.push(`duplicate prefix ${prefix}: ${seen.get(prefix)} and ${f}`);
  } else {
    seen.set(prefix, f);
  }
}

// Warn (do not fail) on gaps — a gap usually means a migration was deleted.
const numbers = [...seen.keys()].filter((p) => !GRANDFATHERED.has(p)).map((p) => parseInt(p, 10)).sort((a, b) => a - b);
for (let i = 1; i < numbers.length; i++) {
  if (numbers[i] - numbers[i - 1] > 1) {
    console.warn(`warning: gap between migration ${numbers[i - 1]} and ${numbers[i]}`);
  }
}

if (errors.length) {
  console.error('Migration naming problems:\n  ' + errors.join('\n  '));
  process.exit(1);
}
console.log(`Migrations OK — ${files.length} files, unique prefixes.`);
