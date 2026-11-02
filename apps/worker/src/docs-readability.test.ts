import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { describe, it } from 'vitest';

/**
 * The published guides read as guides, not as design notes (FRU-515). The rule is in
 * `docs/decisions/conventions.md`, « The published guides »:
 *
 * - no ticket reference (`FRU-` and a number): a reader outside the team cannot open one;
 * - no em dash;
 * - one bold segment per section at most, so that the one there stands out.
 *
 * A heading keeps its words: its id is an address that other pages, `moved.yml` and the extension
 * link to. Code, HTML comments and the front matter are not prose, and are not read.
 */

const ROOT = new URL('../../../', import.meta.url);

/** Pages not rewritten yet: SECURITY.md and the privacy pages go in their own pull request. */
const NOT_YET = new Set(['SECURITY.md', 'docs/privacy.md', 'docs/privacy/delete-notes.md', 'docs/privacy/notice.md']);

/** Every published guide, as a path from the root: the README, and `docs/` without its decisions. */
function published(): string[] {
  const docs = readdirSync(new URL('docs/', ROOT), { recursive: true, encoding: 'utf8' })
    .map((file) => `docs/${file.replaceAll('\\', '/')}`)
    .filter((file) => file.endsWith('.md') && !file.startsWith('docs/decisions/') && !file.includes('/_'));

  return ['README.md', 'SECURITY.md', ...docs].filter((file) => !NOT_YET.has(file)).sort();
}

type Finding = { line: number; what: 'ticket' | 'em dash' | 'second bold'; text: string };

/** What breaks the rule in one page of markdown. */
export function findingsIn(markdown: string): Finding[] {
  const found: Finding[] = [];
  let fence = false;
  let comment = false;
  let front = false;
  let bold = 0;
  markdown.split('\n').forEach((line, index) => {
    const trimmed = line.trim();
    if (index === 0 && trimmed === '---') return void (front = true);
    if (front) return void (trimmed === '---' && (front = false));
    if (/^(```|~~~)/.test(trimmed)) return void (fence = !fence);
    if (fence) return;
    if (comment || line.includes('<!--')) {
      comment = !line.includes('-->');
      return;
    }
    if (/^#{1,6} /.test(line)) return void (bold = 0);
    const prose = line.replaceAll(/`[^`]*`/g, '');
    const at = { line: index + 1, text: trimmed.slice(0, 120) };
    if (/FRU-\d/.test(prose)) found.push({ ...at, what: 'ticket' });
    if (prose.includes('—')) found.push({ ...at, what: 'em dash' });
    // Two marks a segment, which can span two lines: the third mark of a section opens the second.
    for (const _ of prose.matchAll(/\*\*/g)) {
      bold += 1;
      if (bold === 3) found.push({ ...at, what: 'second bold' });
    }
  });

  return found;
}

describe('the published guides (FRU-515)', () => {
  it('name no ticket, write no em dash, and put one bold segment at most in a section', () => {
    const broken = published().flatMap((file) =>
      findingsIn(readFileSync(new URL(file, ROOT), 'utf8')).map(
        (finding) => `${file}:${finding.line} ${finding.what}: ${finding.text}`,
      ),
    );

    assert.ok(published().length > 20, `only ${published().length} pages were read`);
    assert.deepEqual(broken, []);
  });

  it('finds each kind of break, and none in a heading, in code or in a comment (the control)', () => {
    const page = [
      '# A heading (FRU-1) — with **two** **bolds**',
      'A sentence (FRU-12).',
      'An aside — here.',
      'One **bold**, then **another**.',
      '## A section with a bold over two lines',
      'A **bold that',
      'ends here**, then **a second**.',
      '`FRU-3 — **code** **span**`',
      '```',
      'FRU-4 — **fenced** **code**',
      '```',
      '<!-- FRU-5 — a comment',
      '**still** **a comment** -->',
      '## Next section',
      'A **bold** again, the first of its section.',
    ].join('\n');

    assert.deepEqual(
      findingsIn(page).map((finding) => `${finding.line} ${finding.what}`),
      ['2 ticket', '3 em dash', '4 second bold', '7 second bold'],
    );
  });
});
