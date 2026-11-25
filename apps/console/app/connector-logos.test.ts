import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { LOGO_KINDS, logoPath } from './connector-logo-kinds.ts';

/** The console has no DOM under `node --test`: the guard reads the files (FRU-690). */
const PUBLIC = new URL('../public/', import.meta.url);
const LOGOS = new URL('logos/', PUBLIC);
const connectors = readFileSync(new URL('routes/connectors.tsx', import.meta.url), 'utf8');
const parts = readFileSync(new URL('parts/connector-parts.tsx', import.meta.url), 'utf8');

/** The kinds a worker connects today: the keys of `KINDS` (a key may be quoted, 'claude-routine'). */
const KINDS = [
  ...(/export const KINDS = \{([^]*?)\n\} as const/.exec(parts)?.[1] ?? '').matchAll(/^ {2}'?([\w-]+)'?: \{/gm),
].map((match) => match[1] ?? '');

/** A logo file, its comment taken away: what a browser draws and fetches. */
function drawn(svg: string): string {
  return svg.replace(/<!--[^]*?-->/g, '');
}

/** What would make a logo ask anything of another address, or run something. */
const REACHES = /<(?:image|use|script|foreignObject|style)\b|\b(?:href|xlink:href|src)=|url\(|@import/i;

/** The licences a logo may come under: simple-icons, Lucide, and the console's own. */
const LICENCE = /\((?:CC0-1\.0|ISC License)\b|AGPL-3\.0-only/;

describe('the logos of the Connectors screen (FRU-690)', () => {
  it('has a file for each kind of the catalogue, and no file for another', () => {
    const files = readdirSync(LOGOS).sort();
    assert.deepEqual(files, LOGO_KINDS.map((kind) => `${kind}.svg`).sort());
    // Every kind a worker connects today has its logo.
    assert.ok(KINDS.length >= 9, 'the kinds are read');
    for (const kind of KINDS) assert.ok((LOGO_KINDS as readonly string[]).includes(kind), kind);
  });

  it('serves each logo from the console itself, at an address of its own origin', () => {
    for (const kind of LOGO_KINDS) {
      const path = logoPath(kind);
      assert.match(path, /^\/logos\/[a-z-]+\.svg$/);
      assert.equal(new URL(path, 'https://console.example').origin, 'https://console.example');
    }
  });

  it('draws each logo with nothing that reaches another address, and names its source and licence', () => {
    for (const kind of LOGO_KINDS) {
      const svg = readFileSync(new URL(`${kind}.svg`, LOGOS), 'utf8');
      assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 (?:16 16|24 24)">/, kind);
      assert.equal(REACHES.test(drawn(svg)), false, `${kind}.svg reaches elsewhere`);
      assert.match(svg, /<!--[^]*?-->/, `${kind}.svg says its source`);
      assert.match(svg, LICENCE, `${kind}.svg names its licence`);
    }
    // The control: a logo that loads a picture, or one that hides a link in a style, is found.
    assert.equal(REACHES.test(drawn('<svg><image href="https://cdn.example/l.png"/></svg>')), true);
    assert.equal(REACHES.test(drawn('<svg><path style="fill:url(https://x.example/a)"/></svg>')), true);
    assert.equal(REACHES.test(drawn('<svg><!-- https://simpleicons.org --><path d="M0 0"/></svg>')), false);
  });

  it('is drawn before the name of each tile and of each row of the screen', () => {
    // Each entry of the catalogue names a kind that has a logo.
    const catalogue = /const CATALOGUE: readonly Entry\[\] = \[([^]*?)\n\];/.exec(connectors)?.[1] ?? '';
    const kinds = [...catalogue.matchAll(/\bkind: '([\w-]+)'/g)].map((match) => match[1] ?? '');
    assert.deepEqual(kinds.sort(), [...LOGO_KINDS].sort());
    assert.match(connectors, /<ConnectorLogo kind=\{entry\.kind\} \/>/);
    assert.match(connectors, /<ConnectorLogo kind=\{connector\.kind\} size="row" \/>/);
  });
});
