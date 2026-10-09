// Writes the nginx template with the hash of each inline script of the built page (FRU-99).
//
// The SPA build puts a few inline scripts in `index.html`. A policy of `script-src 'self'` would stop
// them, and `'unsafe-inline'` would let an injected script run beside them. Their hashes allow these
// scripts and no other. Run after `react-router build`: `node csp.mjs <template> <out>`.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const [template, out] = process.argv.slice(2);
const page = readFileSync(new URL('./build/client/index.html', import.meta.url), 'utf8');
const hashes = [...page.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)]
  .map((match) => match[1])
  .filter((body) => body.trim() !== '')
  .map((body) => `'sha256-${createHash('sha256').update(body).digest('base64')}'`);

if (hashes.length === 0) throw new Error('No inline script in index.html: the build changed, check the policy.');
writeFileSync(out, readFileSync(template, 'utf8').replaceAll('__SCRIPT_HASHES__', hashes.join(' ')));
console.log(`csp: ${hashes.length} inline scripts allowed by hash`);
