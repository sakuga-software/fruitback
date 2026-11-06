import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/**
 * The box of a read that failed (FRU-508): one `LoadFailed` in the kit, for the five screens that
 * had each their own copy. The one of Members had no title, and said « Try again » twice.
 *
 * The console has no DOM under `node --test`: the guard reads the sources (as FRU-435 does).
 */
const read = (name: string) => readFileSync(new URL(name, import.meta.url), 'utf8');

/** The screens whose main read fails into the box, and what the box says did not load. */
const SCREENS: Readonly<Record<string, string>> = {
  'routes/notes.tsx': 'The notes did not load',
  'routes/sites.tsx': 'The sites did not load',
  'routes/site.tsx': 'The site did not load',
  'routes/members.tsx': 'The members did not load',
  'routes/site-statuses.tsx': 'The statuses did not load',
};

/** The body of the function `name` in `source`: from its line to the first `}` alone on a line. */
function functionOf(source: string, name: string): string {
  const start = source.indexOf(`export function ${name}(`);
  assert.notEqual(start, -1, `${name} is not in the source`);

  return source.slice(start, source.indexOf('\n}\n', start));
}

/** Each `<LoadFailed … />` of a source, as it is written. */
function boxesOf(source: string): string[] {
  return source.match(/<LoadFailed\b[\s\S]*?\n\s*\/>/g) ?? [];
}

/** What is wrong with a box: no title, a title that is not the one of the screen, or two « Try again ». */
function faultsOf(box: string, title: string): string[] {
  const faults: string[] = [];
  if (!box.includes(`title={t('${title}')}`)) faults.push('title');
  if (!box.includes("retry={t('Try again')}")) faults.push('retry');
  // `<ReadProblem alone />` says « try again » in its sentence: beside the button, that is twice.
  const detail = /detail=([\s\S]*?)\n\s*(?:retry|onRetry)=/.exec(box)?.[1] ?? '';
  if (/<ReadProblem alone|try again/i.test(detail)) faults.push('try again twice');

  return faults;
}

describe('the box of a read that failed (FRU-508)', () => {
  it('has one title, one sentence and one button, and is said at once', () => {
    const box = functionOf(read('ui.tsx'), 'LoadFailed');

    assert.match(box, /role="alert"/);
    assert.equal(box.match(/<h2\b/g)?.length, 1);
    assert.equal(box.match(/<p\b/g)?.length, 1);
    assert.equal(box.match(/<Button\b/g)?.length, 1);
    assert.match(box, /onClick=\{onRetry\}/);
  });

  it('is the box of each of the five screens, with its title and one « Try again »', () => {
    for (const [screen, title] of Object.entries(SCREENS)) {
      const boxes = boxesOf(read(screen));

      assert.equal(boxes.length, 1, `${screen} draws ${boxes.length} boxes`);
      assert.deepEqual(faultsOf(boxes[0] as string, title), [], screen);
    }
  });

  it('finds the box of Members of before', () => {
    // The control: the card of before had no title, and its sentence said to try again beside the button.
    const before = `<LoadFailed
          detail={<ReadProblem alone />}
          retry={t('Try again')}
          onRetry={readAll}
        />`;

    assert.deepEqual(faultsOf(before, SCREENS['routes/members.tsx'] as string), ['title', 'try again twice']);
  });
});
