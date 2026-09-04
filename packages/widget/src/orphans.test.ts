import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { seedFixture, seedIssueFixture } from '@fruitback/shared/seed.fixture';
import { type OrphanList, createOrphanList } from './orphans.ts';
import { mountPage } from './dom.fixture.ts';

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

  it('rebuilds when a note changed stage, although nothing here shows the stage yet', () => {
    // It used to assert the *text* changed, because the entry opened with the stage's emoji. SKG-517
    // took that emoji out, so the rendered entry no longer depends on the stage at all — and the old
    // assertion could no longer hold however correct the code was.
    //
    // What is still worth guarding is the signature: it keeps the stage, so a stage change rebuilds.
    // That over-invalidates by one field today and is deliberate, because SKG-529 decides how a stage
    // shows up here and a signature that had forgotten it would leave a stale entry. So this asserts
    // a **new node**, which is what a rebuild actually produces, rather than different text.
    const page = mount();
    list?.update([seedIssueFixture({ seed: seedFixture({ id: 'sd_1' }), stage: 'seeded' })]);
    const before = page.document.querySelector('.fruitback-orphans-item');

    list?.update([seedIssueFixture({ seed: seedFixture({ id: 'sd_1' }), stage: 'composted' })]);

    assert.notEqual(page.document.querySelector('.fruitback-orphans-item'), before, 'a rebuilt node');
  });

  it('no longer puts a glyph in front of a detached note (SKG-517)', () => {
    // The entry opened with `SEED_STAGE_STYLES[stage].emoji`, a rendering decision that travelled in
    // the published contract. There is no glyph by default now; the note's own words are the entry.
    const page = mount();

    list?.update([issue('sd_1', 'Une note')]);

    assert.equal(page.document.querySelector('.fruitback-orphans-note')?.textContent, 'Une note');
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
