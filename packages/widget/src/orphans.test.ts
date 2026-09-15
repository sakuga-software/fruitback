import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { seedFixture, seedIssueFixture } from '@fruitback/shared/seed.fixture';
import { type OrphanList, createOrphanList } from './orphans.ts';
import { mountPage } from './dom.fixture.ts';
import { createTranslator } from './messages.ts';

/**
 * The list on its own. How it behaves inside the overlay is settled in `overlay.test.ts`; what is
 * here is the part a caller can get wrong without noticing.
 */

let list: OrphanList | null = null;

afterEach(() => {
  list?.destroy();
  list = null;
});

function mount() {
  const page = mountPage('<main></main>');
  list = createOrphanList({ document: page.document, host: page.document.body });

  return page;
}

const issue = (id: string, note: string) => seedIssueFixture({ seed: seedFixture({ id, note }) });

describe('createOrphanList', () => {
  it('writes nothing when the set has not changed', () => {
    // The overlay calls this after every resolve, and it observes the document — so a rebuild that
    // changes nothing is a mutation that schedules another resolve.
    const page = mount();
    list?.update([issue('sd_1', 'Une note')]);
    const first = page.document.querySelector('.fruitback-orphans-item');

    list?.update([issue('sd_1', 'Une note')]);

    assert.equal(page.document.querySelector('.fruitback-orphans-item'), first, 'the same node, not a new one');
  });

  it('shows the handle as plain text when the store has nowhere to open (SKG-524)', () => {
    // An anchor with an empty href resolves to the current page, so clicking it would reload the
    // client's site. The identifier is still worth showing, so it degrades to a span rather than
    // vanishing with the link.
    const page = mount();

    list?.update([seedIssueFixture({ seed: seedFixture({ id: 'sd_1' }), url: undefined, identifier: 'FB-7' })]);

    const handle = page.document.querySelector('.fruitback-orphans-link');
    assert.equal(handle?.textContent, 'FB-7');
    assert.equal(handle?.tagName.toLowerCase(), 'span');
    assert.equal(page.document.querySelector('.fruitback-orphans-item a'), null);
  });

  it('links the handle when the store does have somewhere to open', () => {
    const page = mount();

    list?.update([issue('sd_1', 'Une note')]);

    const handle = page.document.querySelector('.fruitback-orphans-link');
    assert.equal(handle?.tagName.toLowerCase(), 'a');
    assert.equal(handle?.getAttribute('href'), 'https://linear.app/sakuga-software/issue/SKG-901');
  });

  it('repaints the entry when a note changed stage (SKG-529)', () => {
    // This assertion has been rewritten twice, and the history is the reason it is worth reading.
    // It first asserted the entry's *text* changed, because the entry opened with the stage's emoji.
    // SKG-517 removed that emoji and nothing rendered here depended on the stage any more, so it
    // fell back to asserting a rebuilt node and left the signature over-invalidating on purpose,
    // pending the ticket that would decide how a stage shows up in this list.
    //
    // That ticket is SKG-529 and the answer is a drop in the stage's colour, so the signature is
    // honest again and this can assert what a reader sees. Drop `:${stage}` from the key in
    // `orphans.ts` and a note that ripens keeps the colour it had — which is what this catches.
    const page = mount();
    list?.update([seedIssueFixture({ seed: seedFixture({ id: 'sd_1' }), stage: 'seeded' })]);
    const before = page.document.querySelector('.fruitback-orphans-stage') as HTMLElement;
    assert.equal(before.style.getPropertyValue('--fruitback-pin-color'), 'var(--fruitback-stage-seeded)');

    list?.update([seedIssueFixture({ seed: seedFixture({ id: 'sd_1' }), stage: 'composted' })]);

    const after = page.document.querySelector('.fruitback-orphans-stage') as HTMLElement;
    assert.equal(after.style.getPropertyValue('--fruitback-pin-color'), 'var(--fruitback-stage-composted)');
  });

  it('says the stage in words too, because colour alone is not a label', () => {
    // The mark is aria-hidden, so without this the stage reaches nobody using a screen reader — and
    // nobody who cannot separate the five colours either.
    const page = mount();

    list?.update([seedIssueFixture({ seed: seedFixture({ id: 'sd_1', note: 'Une note' }), stage: 'ripe' })]);

    assert.equal(page.document.querySelector('.fruitback-orphans-note')?.getAttribute('aria-label'), 'Ripe · Une note');
    assert.equal(page.document.querySelector('.fruitback-orphans-stage')?.getAttribute('aria-hidden'), 'true');
  });

  it('puts no character in front of a detached note (SKG-517, SKG-529)', () => {
    // The entry opened with `SEED_STAGE_STYLES[stage].emoji`, a rendering decision that travelled in
    // the published contract; the chip above it opened with a fallen leaf. Both are drawings now, so
    // the entry's text is the note's own words and nothing else.
    const page = mount();

    list?.update([issue('sd_1', 'Une note')]);

    assert.equal(page.document.querySelector('.fruitback-orphans-note')?.textContent, 'Une note');
    assert.equal(page.document.querySelector('.fruitback-orphans-toggle')?.textContent, '1 detached note');
  });

  it('counts in the plural forms of the locale, not with an appended s (SKG-530)', () => {
    // Polish has three forms where English has two, so "add an s after one" is wrong at 5 and at 22.
    const page = mountPage('<main></main>');
    const forms = { one: '{count} notatka', few: '{count} notatki', many: '{count} notatek', other: '{count} notatki' };
    list = createOrphanList({
      document: page.document,
      host: page.document.body,
      translator: createTranslator({ locale: 'pl', messages: { pl: { 'orphans.count': forms } } }),
    });
    const count = () => page.document.querySelector('.fruitback-orphans-toggle')?.textContent;
    const issues = (n: number) => Array.from({ length: n }, (_, index) => issue(`sd_${index}`, `Note ${index}`));

    list.update(issues(1));
    assert.equal(count(), '1 notatka');
    list.update(issues(5));
    assert.equal(count(), '5 notatek');
    list.update(issues(22));
    assert.equal(count(), '22 notatki');
  });

  it('finds the entry of a listed note, and nothing for another', () => {
    const page = mount();
    list?.update([issue('sd_1', 'Une note'), issue('sd_2', 'Une autre')]);

    const entry = list?.entry('sd_2');
    assert.ok(entry !== undefined && entry.textContent === 'Une autre', 'the entry of sd_2 was not found');
    assert.ok(entry === page.document.querySelectorAll('.fruitback-orphans-note')[1], 'another entry was returned');
    assert.equal(list?.entry('sd_unknown'), undefined);
  });

  it('owns its own DOM and nothing else', () => {
    const page = mount();
    list?.update([issue('sd_1', 'Une note')]);

    assert.equal(list?.owns(page.document.querySelector('.fruitback-orphans-note') as Node), true);
    assert.equal(list?.owns(page.document.querySelector('main') as Node), false);
  });

  it('falls back to the element when the note is empty', () => {
    // A pin planted with a screenshot and no text is still worth finding again.
    const page = mount();
    list?.update([issue('sd_1', '   ')]);

    assert.match(page.document.querySelector('.fruitback-orphans-note')?.textContent ?? '', /</);
  });
});

describe('announcing detached notes (SKG-544)', () => {
  const announced = (page: ReturnType<typeof mount>) =>
    page.document.querySelector('[data-fruitback-orphans-announcer]')?.textContent ?? '';

  it('announces detached notes when more of them appear', () => {
    const page = mount();

    list?.update([issue('sd_1', 'Une note')]);
    assert.equal(announced(page), '1 detached note');

    list?.update([issue('sd_1', 'Une note'), issue('sd_2', 'Une autre')]);
    assert.equal(announced(page), '2 detached notes');
  });

  it('announces nothing new when a note is found again', () => {
    const page = mount();
    list?.update([issue('sd_1', 'Une note'), issue('sd_2', 'Une autre')]);

    list?.update([issue('sd_1', 'Une note')]);

    assert.equal(announced(page), '2 detached notes');
  });

  it('goes quiet when the list empties, and owns the region it speaks through', () => {
    const page = mount();
    list?.update([issue('sd_1', 'Une note')]);

    list?.update([]);

    assert.equal(announced(page), '');
    const region = page.document.querySelector('[data-fruitback-orphans-announcer]');
    assert.equal(region?.getAttribute('role'), 'status');
    assert.equal(list?.owns(region as Node), true, 'the overlay would take a new announcement for a page change');
  });
});
