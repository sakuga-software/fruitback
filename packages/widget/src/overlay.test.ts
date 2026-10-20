import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { seedFixture, seedIssueFixture } from '@fruitback/shared/seed.fixture';
import type { SeedIssue } from '@fruitback/shared';
import { type Overlay, createOverlay } from './overlay.ts';
import { createTranslator } from './messages.ts';
import { type MountedPage, mountPage, pressKey, setDocumentSize, setRect } from './dom.fixture.ts';

const PAGE = '<main><section><button data-testid="checkout-cta">Commander</button></section></main>';

let overlay: Overlay | null = null;

afterEach(() => {
  overlay?.destroy();
  overlay = null;
});

function mountWithCta(): MountedPage {
  const page = mountPage(PAGE, { width: 1_000, height: 1_000 });
  setDocumentSize(page.document, 1_000, 1_000);
  setRect(page.query('button'), { left: 100, top: 200, width: 200, height: 40 });

  return page;
}

/** The seed the fixture plants, re-pointed at the button this page actually has. */
function issueOnCta(overrides: Parameters<typeof seedIssueFixture>[0] = {}) {
  return seedIssueFixture({
    seed: seedFixture({
      anchor: {
        selector: '[data-testid="checkout-cta"]',
        tag: 'button',
        text: 'Commander',
        bounds: { xPct: 10, yPct: 20, wPct: 20, hPct: 4 },
      },
    }),
    ...overrides,
  });
}

describe('createOverlay', () => {
  it('draws a pin over the element, in document coordinates', () => {
    const page = mountWithCta();
    overlay = createOverlay({ document: page.document });

    overlay.render([issueOnCta()]);

    const pin = page.document.querySelector('[data-fruitback-pin]') as HTMLElement;
    // The frame stands 5 px off the element on every side: a line of 2 px, 3 px off (FRU-304).
    assert.equal(pin.style.left, '95px');
    assert.equal(pin.style.top, '195px');
    assert.equal(pin.style.width, '210px');
    assert.equal(pin.style.height, '50px');
    // The point of the drop is 16 px in from the start corner of the element, on its top edge.
    assert.equal(pin.style.getPropertyValue('--fruitback-pin-tip-x'), '21px');
    assert.equal(pin.style.getPropertyValue('--fruitback-pin-tip-y'), '5px');
    assert.equal(pin.dataset.fruitbackStrategy, 'selector');
  });

  it('colours the pin by the Linear state, not by anything it stores itself', () => {
    const page = mountWithCta();
    overlay = createOverlay({ document: page.document });

    overlay.render([issueOnCta({ stage: 'ripe', stateName: 'Done' })]);

    const pin = page.document.querySelector('[data-fruitback-pin]') as HTMLElement;
    assert.equal(pin.dataset.fruitbackStage, 'ripe');
    // The token, not the hexadecimal (FRU-35). What the pin actually renders is asserted end to
    // end in `e2e/overlay.spec.ts`, which reads the computed colour in a real browser — the only
    // place a `var()` can be resolved at all.
    assert.equal(pin.style.getPropertyValue('--fruitback-pin-color'), 'var(--fruitback-stage-ripe)');
  });

  it('draws a note kept for later as a neutral pin that says it is not sent (FRU-124)', () => {
    const page = mountWithCta();
    // As `embed.ts` builds it: no issue yet, so no address of an issue.
    const { url: _none, ...draft } = issueOnCta({ id: 'draft:sd_kept' });
    const sent = issueOnCta({ id: 'issue_sent', stage: 'ripe' });
    overlay = createOverlay({ document: page.document, isDraft: (issue) => issue === draft });
    overlay.render([sent, draft]);

    const [first, second] = [...page.document.querySelectorAll<HTMLElement>('[data-fruitback-pin]')];
    // The control: the same seed, sent, wears its stage.
    assert.equal(first?.style.getPropertyValue('--fruitback-pin-color'), 'var(--fruitback-stage-ripe)');
    assert.equal(first?.dataset.fruitbackDraft, undefined);
    assert.equal(second?.style.getPropertyValue('--fruitback-pin-color'), 'var(--fruitback-color-text-muted)');
    assert.equal(second?.dataset.fruitbackDraft, '');
    const badge = second?.querySelector('.fruitback-pin-badge') as HTMLElement;
    assert.match(badge.getAttribute('aria-label') ?? '', /^Not sent yet · /);
    // No number: it is not a note of the tracker yet, and the sent one beside it is note 1.
    assert.deepEqual([first?.textContent, second?.textContent], ['1', '']);

    badge.click();
    assert.equal(page.document.querySelector('.fruitback-thread-stage')?.textContent, 'Not sent yet');
    // A boolean, not the node: a failed comparison of a DOM node never finishes printing it.
    assert.equal(page.document.querySelector('.fruitback-thread-link') === null, true);
  });

  it('keeps a draft whose element is gone out of the detached notes, which name a stage (FRU-124)', () => {
    const page = mountWithCta();
    page.query('button').remove();
    const draft = issueOnCta({ id: 'draft:sd_kept' });
    overlay = createOverlay({ document: page.document, isDraft: (issue) => issue === draft });

    overlay.render([draft]);
    assert.equal((page.document.querySelector('[data-fruitback-orphans]') as HTMLElement).hidden, true);
    assert.ok(page.document.querySelector('[data-fruitback-pin]'), 'the draft lost its pin');

    // The control: the same note, sent, is listed there.
    overlay.render([issueOnCta()]);
    assert.equal((page.document.querySelector('[data-fruitback-orphans]') as HTMLElement).hidden, false);
  });

  it('draws one object as a draft and then as a sent note, with nothing left of the draft', () => {
    // The caller says what is a draft at each draw. The marks are kept apart from the pins and
    // outlive a render: the same object, sent since, must get its number and lose the neutral look.
    const page = mountWithCta();
    const note = issueOnCta();
    let kept = true;
    overlay = createOverlay({ document: page.document, isDraft: () => kept });
    const pin = () => page.document.querySelector('[data-fruitback-pin]') as HTMLElement;

    overlay.render([note]);
    assert.equal(pin().dataset.fruitbackDraft, '');
    assert.equal(pin().querySelector('.fruitback-pin-glyph')?.textContent, '');

    kept = false;
    overlay.render([note]);
    assert.equal(pin().dataset.fruitbackDraft, undefined);
    assert.equal(pin().querySelector('.fruitback-pin-glyph')?.textContent, '1');
    assert.match(pin().querySelector('.fruitback-pin-badge')?.getAttribute('aria-label') ?? '', /^Note 1, /);

    // And back: a draft has no number.
    kept = true;
    overlay.render([note]);
    assert.equal(pin().dataset.fruitbackDraft, '');
    assert.equal(pin().querySelector('.fruitback-pin-glyph')?.textContent, '');
    assert.equal(overlay.resolutions()[0]?.number, undefined);
  });

  it('numbers the notes of the page, names each pin by its number and status, and says which is open (FRU-252)', () => {
    const page = mountWithCta();
    const hidden = new Set<string>();
    overlay = createOverlay({ document: page.document, shouldShow: (issue) => !hidden.has(issue.id) });
    const note = (n: number, stage: 'seeded' | 'ripening' | 'ripe') =>
      seedIssueFixture({
        id: `issue_${n}`,
        stage,
        seed: { ...issueOnCta().seed, id: `sd_${n}`, note: `Note text ${n}` },
      });
    const issues = [note(1, 'seeded'), note(2, 'ripening'), note(3, 'ripe')];
    overlay.render(issues);

    const badges = () => [...page.document.querySelectorAll<HTMLElement>('.fruitback-pin-badge')];
    assert.deepEqual(
      badges().map((badge) => [
        badge.textContent,
        badge.getAttribute('aria-label'),
        badge.getAttribute('aria-expanded'),
      ]),
      [
        ['1', 'Note 1, new: Note text 1', 'false'],
        ['2', 'Note 2, in progress: Note text 2', 'false'],
        ['3', 'Note 3, done: Note text 3', 'false'],
      ],
    );
    assert.deepEqual(
      overlay.resolutions().map((each) => each.number),
      [1, 2, 3],
    );

    badges()[1]?.click();
    assert.deepEqual(
      badges().map((badge) => badge.getAttribute('aria-expanded')),
      ['false', 'true', 'false'],
    );
    pressKey(page, 'Escape');
    assert.deepEqual(
      badges().map((badge) => badge.getAttribute('aria-expanded')),
      ['false', 'false', 'false'],
    );

    // A stage the reporter hid takes no number from the others: note 3 stays note 3.
    hidden.add('issue_2');
    overlay.refilter();
    assert.deepEqual(
      badges().map((badge) => badge.textContent),
      ['1', '3'],
    );
  });

  it('places a pin whose element is gone at its remembered position, and says so', () => {
    const page = mountWithCta();
    page.query('button').remove();
    overlay = createOverlay({ document: page.document });

    overlay.render([issueOnCta()]);

    const pin = page.document.querySelector('[data-fruitback-pin]') as HTMLElement;
    assert.equal(pin.dataset.fruitbackStrategy, 'orphan');
    assert.ok(pin.className.includes('fruitback-pin-orphan'));
    // 10% of 1000 across, 20% down: the box the note was planted on, and the frame 5 px off it.
    assert.equal(pin.style.left, '95px');
    assert.equal(pin.style.top, '195px');
  });

  it('marks a pin it placed by position rather than recognised', () => {
    // The page changed under the anchor: no selector, no test id, a word three buttons share. The
    // pin still lands, and it says out loud that it is a guess.
    const page = mountWithCta();
    overlay = createOverlay({ document: page.document });

    overlay.render([
      issueOnCta({
        seed: seedFixture({
          anchor: { selector: '#gone', tag: 'button', bounds: { xPct: 10, yPct: 20, wPct: 20, hPct: 4 } },
        }),
      }),
    ]);

    const pin = page.document.querySelector('[data-fruitback-pin]') as HTMLElement;
    assert.equal(pin.dataset.fruitbackStrategy, 'bounds');
    assert.equal(pin.dataset.fruitbackConfident, 'false');
    assert.ok(pin.className.includes('fruitback-pin-uncertain'));
    // The drop holds the number of the note (FRU-252). Its name says the place is approximate.
    const unsure = page.document.querySelector('.fruitback-pin-badge');
    assert.equal(unsure?.textContent, '1');
    assert.match(unsure?.getAttribute('aria-label') ?? '', /^Note 1, .+, approximate position: /);

    (page.document.querySelector('.fruitback-pin-badge') as HTMLElement).click();
    assert.match(page.document.querySelector('[data-fruitback-thread]')?.textContent ?? '', /by its position/i);
  });

  it('re-measures when the page moves under it', () => {
    const page = mountWithCta();
    overlay = createOverlay({ document: page.document });
    overlay.render([issueOnCta()]);

    // A banner appeared above and pushed everything down.
    setRect(page.query('button'), { left: 100, top: 460, width: 200, height: 40 });
    overlay.reposition();

    assert.equal((page.document.querySelector('[data-fruitback-pin]') as HTMLElement).style.top, '455px');
  });

  it('falls back to the remembered box when the element is torn out of the page', () => {
    // An SPA re-renders and the node we resolved is detached. A detached node measures 0×0, which
    // would slide the pin into the top-left corner and read as a bug in the overlay.
    const page = mountWithCta();
    overlay = createOverlay({ document: page.document });
    overlay.render([issueOnCta()]);

    page.query('button').remove();
    overlay.reposition();

    const pin = page.document.querySelector('[data-fruitback-pin]') as HTMLElement;
    assert.equal(pin.style.left, '95px');
    assert.equal(pin.style.top, '195px');
    assert.ok(pin.className.includes('fruitback-pin-orphan'), 'the pin should show that it lost its element');
  });

  it('does not close the thread when the click is inside it', () => {
    const page = mountWithCta();
    overlay = createOverlay({ document: page.document });
    overlay.render([issueOnCta()]);
    (page.document.querySelector('.fruitback-pin-badge') as HTMLElement).click();

    (page.document.querySelector('.fruitback-thread-note') as HTMLElement).click();

    assert.ok(page.document.querySelector('[data-fruitback-thread]'), 'the thread closed under its own click');
  });

  it('lets clicks through to the page, except on the badge', () => {
    // A widget that swallows the client's own buttons is one they turn off.
    const page = mountWithCta();
    overlay = createOverlay({ document: page.document });
    overlay.render([issueOnCta()]);

    const pin = page.document.querySelector('.fruitback-pin') as HTMLElement;
    const badge = page.document.querySelector('.fruitback-pin-badge') as HTMLElement;
    const styles = page.view.getComputedStyle(pin);

    assert.equal(styles.pointerEvents, 'none');
    assert.equal(page.view.getComputedStyle(badge).pointerEvents, 'auto');
  });

  it('fans out the badges of several notes on one element, and leaves a lone note where it was (FRU-155)', () => {
    // The badges sat on one point: one drop showed, and only the last one took the click.
    const page = mountPage(`${PAGE}<p id="aside">À côté</p>`, { width: 1_000, height: 1_000 });
    setDocumentSize(page.document, 1_000, 1_000);
    setRect(page.query('button'), { left: 100, top: 200, width: 200, height: 40 });
    setRect(page.query('#aside'), { left: 400, top: 200, width: 100, height: 20 });
    overlay = createOverlay({ document: page.document });

    const onCta = (n: number) =>
      seedIssueFixture({
        id: `issue_${n}`,
        identifier: `SKG-${n}`,
        seed: { ...issueOnCta().seed, id: `sd_cta_${n}`, note: `Note ${n}` },
      });
    const aside = seedIssueFixture({
      id: 'issue_aside',
      seed: seedFixture({
        id: 'sd_aside',
        anchor: { selector: '#aside', tag: 'p', text: 'À côté', bounds: { xPct: 40, yPct: 20, wPct: 10, hPct: 2 } },
      }),
    });
    overlay.render([onCta(1), aside, onCta(2), onCta(3)]);

    const slots = [...page.document.querySelectorAll<HTMLElement>('[data-fruitback-pin]')].map((pin) => [
      pin.dataset.fruitbackPin,
      pin.style.getPropertyValue('--fruitback-pin-slot'),
    ]);
    assert.deepEqual(slots, [
      ['sd_cta_1', '0'],
      ['sd_aside', '0'],
      ['sd_cta_2', '1'],
      ['sd_cta_3', '2'],
    ]);
    // The stylesheet is what turns the slot into a distance.
    assert.match(
      page.document.querySelector('style')?.textContent ?? '',
      /left: calc\(var\(--fruitback-pin-tip-x, 0px\) - 16px \+ var\(--fruitback-pin-slot, 0\) \* 30px\)/,
    );

    // Each badge still opens its own note.
    (page.document.querySelector('[data-fruitback-pin="sd_cta_2"] .fruitback-pin-badge') as HTMLElement).click();
    assert.equal(page.document.querySelector('.fruitback-thread-note')?.textContent, 'Note 2');
  });

  it('points the drop at its element, and lowers it at the top of the document (FRU-304)', () => {
    // A drop is 34 px tall above its point: at the top of the page, the point goes down by what is missing.
    const page = mountPage(`${PAGE}<p id="top">En haut</p><i id="thin">i</i>`, { width: 1_000, height: 1_000 });
    setDocumentSize(page.document, 1_000, 1_000);
    setRect(page.query('button'), { left: 100, top: 200, width: 200, height: 40 });
    setRect(page.query('#top'), { left: 300, top: 10, width: 100, height: 20 });
    setRect(page.query('#thin'), { left: 500, top: 300, width: 10, height: 20 });
    overlay = createOverlay({ document: page.document });
    const on = (id: string, selector: string, tag: string) =>
      seedIssueFixture({
        id: `issue_${id}`,
        seed: seedFixture({ id, anchor: { selector, tag, bounds: { xPct: 1, yPct: 1, wPct: 1, hPct: 1 } } }),
      });
    overlay.render([on('sd_top', '#top', 'p'), on('sd_thin', '#thin', 'i')]);
    const tip = (id: string) => {
      const pin = page.document.querySelector<HTMLElement>(`[data-fruitback-pin="${id}"]`) as HTMLElement;

      return [pin.style.getPropertyValue('--fruitback-pin-tip-x'), pin.style.getPropertyValue('--fruitback-pin-tip-y')];
    };
    // 10 px from the top: 24 px are missing above it, and the point goes 24 px into the element.
    assert.deepEqual(tip('sd_top'), ['21px', '29px']);
    // An element narrower than 32 px: its middle.
    assert.deepEqual(tip('sd_thin'), ['10px', '5px']);
  });

  it('draws no pin on the page for a note whose element is gone: it is in the dock (FRU-304)', () => {
    const page = mountWithCta();
    page.query('button').remove();
    overlay = createOverlay({ document: page.document });
    overlay.render([issueOnCta()]);
    const sheet = (page.document.querySelector('style')?.textContent ?? '').replace(/\/\*[\s\S]*?\*\//g, '');
    assert.match(sheet, /\.fruitback-pin-orphan:not\(\[data-fruitback-draft\]\) \{ display: none; \}/);
    assert.ok(page.document.querySelector('[data-fruitback-pin]')?.classList.contains('fruitback-pin-orphan'));
  });

  it('shows the frame only while its note is pointed at, focused or open (FRU-158, FRU-304)', () => {
    // A frame left on lined every annotated element, and a page with many notes became hard to read.
    const page = mountWithCta();
    overlay = createOverlay({ document: page.document });
    overlay.render([issueOnCta()]);

    const sheet = page.document.querySelector('style')?.textContent ?? '';
    const pinRule = /\.fruitback-pin \{[^}]*\}/.exec(sheet)?.[0] ?? '';
    assert.match(pinRule, /border: 2px solid transparent/);
    assert.doesNotMatch(pinRule, /background/);
    // In a rule of its own: a browser with no :has() drops the whole rule that names it.
    const rules = sheet.replace(/\/\*[\s\S]*?\*\//g, '');
    const openRule = /[^}]*\.fruitback-pin\[data-fruitback-open\][^{]*\{[^}]*\}/.exec(rules)?.[0] ?? '';
    assert.match(openRule, /border-color: var\(--fruitback-pin-color\)/);
    assert.doesNotMatch(openRule, /:has\(/);
  });

  it('stacks a marked pin above every other pin, not under them (FRU-299, FRU-326)', () => {
    const page = mountWithCta();
    overlay = createOverlay({ document: page.document });
    overlay.render([issueOnCta()]);
    assert.equal(overlay.mark(issueOnCta().seed.id), true);
    assert.ok(page.document.querySelector('[data-fruitback-pin]')?.hasAttribute('data-fruitback-marked'));

    const rules = (page.document.querySelector('style')?.textContent ?? '').replace(/\/\*[\s\S]*?\*\//g, '');
    const zOf = (rule: RegExp) => Number(/z-index: (\d+)/.exec(rule.exec(rules)?.[0] ?? '')?.[1]);
    const pin = zOf(/\.fruitback-pin \{[^}]*\}/);
    const marked = zOf(/\.fruitback-pin\[data-fruitback-marked\] \{[^}]*\}/);
    // A z-index is compared with the one of its siblings: below theirs, the marked pin went under them.
    assert.ok(pin > 0, 'no z-index on a pin');
    assert.ok(marked > pin, `the marked pin is at ${marked}, under the others at ${pin}`);
  });

  it('falls back to the stage when the store reports no state name (FRU-24)', () => {
    // The Linear connector reports `node.state?.name ?? ''`, so an issue with no state gives an empty
    // string. That used to leave a lone glyph in the header; with the glyph gone it would leave an
    // empty span — a thread whose top row is just a close button. Raised in review.
    const page = mountWithCta();
    overlay = createOverlay({ document: page.document });
    overlay.render([issueOnCta({ stateName: '', stage: 'ripening' })]);

    (page.document.querySelector('.fruitback-pin-badge') as HTMLElement).click();

    const header = page.document.querySelector('.fruitback-thread-stage');
    assert.equal(header?.textContent, 'In progress');
  });

  it('leaves no dangling separator in the badge tooltip when the state is unnamed', () => {
    // The second site of the same hole, and the reason `stateLabel` is a function: the header was
    // fixed and this one was left behind, giving `SKG-742 · ` with nothing after the separator.
    // Raised in review on FRU-24.
    const page = mountWithCta();
    overlay = createOverlay({ document: page.document });
    overlay.render([issueOnCta({ identifier: 'SKG-742', stateName: '', stage: 'composted' })]);

    const badge = page.document.querySelector('.fruitback-pin-badge');
    // « Closed · the note », as the mock-up writes it (FRU-304).
    assert.match(badge?.getAttribute('title') ?? '', /^Closed · \S/);
  });

  it('closes the thread with a drawing rather than a character (FRU-36)', () => {
    // The close button was a multiplication sign set at 18px, which every font draws differently and
    // no font aligns on the header's baseline. It is `ph:x-bold` now — a filled path, sized in em and
    // painted in currentColor. Its name stays on the button, so nothing about the change reaches a
    // reader.
    const page = mountWithCta();
    overlay = createOverlay({ document: page.document });
    overlay.render([issueOnCta({})]);

    (page.document.querySelector('.fruitback-pin-badge') as HTMLElement).click();

    const close = page.document.querySelector('.fruitback-thread-close');
    assert.ok(close?.querySelector('svg.fruitback-icon'), 'the close button is not drawn');
    assert.equal(close?.textContent, '', 'the close button still carries a character');
    assert.equal(close?.getAttribute('aria-label'), 'Close the note');
  });

  it('prefers the store’s own word when it has one', () => {
    // The fallback must not swallow the real answer: Linear's "In Progress" is what a team named its
    // column, and the contract's stage vocabulary is not a substitute for it.
    const page = mountWithCta();
    overlay = createOverlay({ document: page.document });
    overlay.render([issueOnCta({ stateName: 'In Progress', stage: 'ripening' })]);

    (page.document.querySelector('.fruitback-pin-badge') as HTMLElement).click();

    assert.equal(page.document.querySelector('.fruitback-thread-stage')?.textContent, 'In Progress');
  });

  it('names no vendor in the way out, because the widget does not know which store answered', () => {
    // The label said "sur Linear" until FRU-31, in a widget that is not supposed to know what is
    // behind the worker — the same defect `store-unavailable` fixed in the error codes.
    const page = mountWithCta();
    overlay = createOverlay({ document: page.document });
    overlay.render([issueOnCta({ identifier: 'SKG-742' })]);

    (page.document.querySelector('.fruitback-pin-badge') as HTMLElement).click();

    const link = page.document.querySelector('[data-fruitback-thread] a');
    assert.match(link?.textContent ?? '', /SKG-742/);
    assert.doesNotMatch(link?.textContent ?? '', /Linear/);
  });

  it('draws no link at all when the store has nowhere to open (FRU-31)', () => {
    // SQLite has no interface, so it reports no `url`. An anchor with an empty href resolves to the
    // current page: clicking it would reload the client's site and lose whatever they were doing —
    // and a link that goes nowhere reads as the store having lost the note.
    const page = mountWithCta();
    overlay = createOverlay({ document: page.document });
    overlay.render([issueOnCta({ url: undefined, identifier: 'FB-12' })]);

    (page.document.querySelector('.fruitback-pin-badge') as HTMLElement).click();

    const thread = page.document.querySelector('[data-fruitback-thread]');
    assert.ok(thread, 'no thread opened');
    assert.equal(thread.querySelector('a'), null, 'a store with no interface must draw no anchor');
    // The rest of the thread is untouched: it is the link that is absent, not the note.
    assert.match(thread.textContent ?? '', /Commander/);
  });

  it('lays the bubble out as the mock-up does: a head, the note, and the replies apart (FRU-256, FRU-304)', () => {
    const page = mountWithCta();
    overlay = createOverlay({ document: page.document });
    overlay.render([
      issueOnCta({
        identifier: 'SKG-742',
        stateName: 'In Progress',
        comments: [{ id: 'c1', body: 'On regarde ça.', createdAt: '2026-08-01T10:00:00.000Z', author: 'Alice' }],
      }),
    ]);

    (page.document.querySelector('.fruitback-pin-badge') as HTMLElement).click();

    const thread = page.document.querySelector('[data-fruitback-thread]') as HTMLElement;
    const classes = (parent: Element) => [...parent.children].map((child) => child.className);
    assert.deepEqual(classes(thread), ['fruitback-thread-head', 'fruitback-thread-body', 'fruitback-thread-answers']);
    // The head: the state behind its drop, since when, the way out, and the cross.
    const head = thread.querySelector('.fruitback-thread-head') as HTMLElement;
    assert.deepEqual(classes(head), [
      'fruitback-thread-stage',
      'fruitback-thread-age',
      'fruitback-thread-link',
      'fruitback-thread-close',
    ]);
    assert.equal(head.querySelector('.fruitback-thread-drop')?.getAttribute('aria-hidden'), 'true');
    assert.equal(head.querySelector('.fruitback-thread-stage')?.textContent, 'In Progress');
    // The age of the state, from the last change the store reports, with the day in its title.
    assert.ok((head.querySelector('.fruitback-thread-age')?.textContent ?? '') !== '');
    assert.ok((head.querySelector('.fruitback-thread-age')?.getAttribute('title') ?? '') !== '');
    // The identifier and an arrow, in a chip: no name of a store the widget does not know.
    assert.equal(head.querySelector('a')?.textContent, 'SKG-742 →');
    assert.deepEqual(classes(thread.querySelector('.fruitback-thread-body') as HTMLElement), [
      'fruitback-thread-note',
      'fruitback-thread-meta',
      'fruitback-thread-source',
    ]);
    // « Replies » above the list, and the initial of who answered in a round (FRU-304).
    const answers = thread.querySelector('.fruitback-thread-answers') as HTMLElement;
    assert.equal(answers.querySelector('.fruitback-thread-answers-title')?.textContent, 'Replies');
    assert.equal(thread.querySelector('.fruitback-thread-reply-avatar')?.textContent, 'A');
    assert.equal(thread.querySelector('.fruitback-thread-reply-avatar')?.getAttribute('aria-hidden'), 'true');
    // Who answered is told apart from when: the name has its own element, which the stylesheet inks.
    assert.equal(thread.querySelector('.fruitback-thread-reply-name')?.textContent, 'Alice');
    assert.match(thread.querySelector('.fruitback-thread-reply-who')?.textContent ?? '', /^Alice · /);
    // FRU-256 builds no way to answer from the page: that waits for a decision (Q9).
    assert.equal(thread.querySelector('form, textarea, input') === null, true);
  });

  it('shows the selector, then the component and the file, and the selector alone without them (FRU-256, FRU-304)', () => {
    const lineFor = (source: SeedIssue['seed']['source']) => {
      const page = mountWithCta();
      const issue = issueOnCta();
      const { source: _dropped, ...seed } = issue.seed;
      overlay = createOverlay({ document: page.document });
      overlay.render([{ ...issue, seed: source === undefined ? seed : { ...seed, source } }]);
      (page.document.querySelector('.fruitback-pin-badge') as HTMLElement).click();
      // The selector the note carries, always first.
      assert.equal(
        page.document.querySelector('.fruitback-thread-source > .fruitback-thread-selector')?.textContent,
        issue.seed.anchor.selector,
      );
      const line = page.document.querySelector('.fruitback-thread-component');
      const text = line === null ? null : line.textContent;
      overlay.destroy();
      overlay = null;

      return text;
    };

    assert.equal(
      lineFor({ component: 'HeroBanner', file: 'src/components/Hero.tsx', line: 42, column: 7 }),
      '<HeroBanner> · src/components/Hero.tsx:42',
    );
    assert.equal(lineFor({ component: 'HeroBanner' }), '<HeroBanner>');
    assert.equal(lineFor({ file: 'src/components/Hero.tsx' }), 'src/components/Hero.tsx');
    // A page with no React, or a production build: no line, and no empty box in its place.
    assert.equal(lineFor(undefined), null);
    assert.equal(lineFor({ line: 42 }), null);
    // As text: a name is whatever the page called its component.
    assert.equal(lineFor({ component: '<img src=x onerror=alert(1)>' }), '<<img src=x onerror=alert(1)>>');
  });

  it('opens the thread on the badge: the note, the state and the way to Linear', () => {
    const page = mountWithCta();
    overlay = createOverlay({ document: page.document });
    overlay.render([issueOnCta({ identifier: 'SKG-742', stateName: 'In Progress' })]);

    (page.document.querySelector('.fruitback-pin-badge') as HTMLElement).click();

    const thread = page.document.querySelector('[data-fruitback-thread]');
    assert.ok(thread, 'no thread opened');
    assert.match(thread.textContent ?? '', /In Progress/);
    assert.match(thread.textContent ?? '', /Commander/);
    const link = thread.querySelector('a');
    assert.equal(link?.getAttribute('href'), 'https://linear.app/sakuga-software/issue/SKG-901');
    assert.match(link?.textContent ?? '', /SKG-742/);
  });

  it('warns in the thread when the pin is only a remembered position', () => {
    const page = mountWithCta();
    page.query('button').remove();
    overlay = createOverlay({ document: page.document });
    overlay.render([issueOnCta()]);

    (page.document.querySelector('.fruitback-pin-badge') as HTMLElement).click();

    assert.match(page.document.querySelector('[data-fruitback-thread]')?.textContent ?? '', /not found/i);
  });

  it('closes the thread on Escape', () => {
    const page = mountWithCta();
    overlay = createOverlay({ document: page.document });
    overlay.render([issueOnCta()]);
    (page.document.querySelector('.fruitback-pin-badge') as HTMLElement).click();

    pressKey(page, 'Escape');

    assert.equal(page.document.querySelector('[data-fruitback-thread]'), null);
  });

  it('reports what found each pin, so a bad resolution is visible rather than plausible', () => {
    const page = mountWithCta();
    overlay = createOverlay({ document: page.document });
    const onScreen = issueOnCta();
    const gone = issueOnCta({
      seed: seedFixture({
        id: 'sd_gone',
        anchor: { selector: '#nowhere', tag: 'button', bounds: { xPct: 90, yPct: 90, wPct: 2, hPct: 1 } },
      }),
    });

    overlay.render([onScreen, gone]);

    assert.deepEqual(
      overlay.resolutions().map((entry) => entry.strategy),
      ['selector', 'orphan'],
    );
  });

  it('takes its own DOM with it when destroyed', () => {
    const page = mountWithCta();
    overlay = createOverlay({ document: page.document });
    overlay.render([issueOnCta()]);

    overlay.destroy();
    overlay = null;

    assert.equal(page.document.querySelector('[data-fruitback-pin]'), null);
    assert.equal(page.document.querySelector('[data-fruitback-overlay]'), null);
  });
});

describe('the page changing underneath', () => {
  /** The observer coalesces bursts, so a test has to wait past the debounce. */
  const settle = () => new Promise((resolve) => setTimeout(resolve, 200));

  it('re-resolves its pins when the page swaps a subtree, with nobody asking it to', async () => {
    // The defect this closes: a framework replaces the element a pin was resolved against, and
    // neither scroll nor resize fires.
    const page = mountWithCta();
    const resolved: string[] = [];
    overlay = createOverlay({
      document: page.document,
      onResolve: (entries) => resolved.push(...entries.map((entry) => entry.strategy)),
    });
    overlay.render([issueOnCta()]);
    const before = page.document.querySelector('[data-fruitback-pin]') as HTMLElement;
    assert.equal(before.dataset.fruitbackStrategy, 'selector');

    // What React does on a re-render: the old node goes, an equivalent one takes its place
    // elsewhere on the page.
    page.query('button').remove();
    const replacement = page.document.createElement('button');
    replacement.dataset.testid = 'checkout-cta';
    replacement.textContent = 'Commander';
    page.document.querySelector('main')?.append(replacement);
    setRect(replacement, { left: 400, top: 600, width: 200, height: 40 });

    await settle();

    const pin = page.document.querySelector('[data-fruitback-pin]') as HTMLElement;
    assert.equal(pin.style.left, '395px', 'the pin followed its element');
    assert.equal(pin.style.top, '595px');
    assert.deepEqual(resolved, ['selector'], 'and the host was told, rather than asked to notice');
  });

  it('stops claiming to be sure when the element it recognised is gone', async () => {
    const page = mountWithCta();
    overlay = createOverlay({ document: page.document });
    overlay.render([issueOnCta()]);

    const pin = page.document.querySelector('[data-fruitback-pin]') as HTMLElement;
    assert.equal(pin.dataset.fruitbackConfident, 'true');

    page.query('button').remove();
    await settle();

    // Re-resolved in place: the same pin element, carrying different marks.
    assert.equal(pin.dataset.fruitbackConfident, 'false');
    assert.match(pin.querySelector('.fruitback-pin-badge')?.getAttribute('aria-label') ?? '', /approximate position/);
    assert.ok(pin.classList.contains('fruitback-pin-uncertain'));
  });

  it('does not close a thread someone is reading', async () => {
    // `render` rebuilds and would close it. A page mutating while a note is open is normal on an
    // SPA.
    const page = mountWithCta();
    overlay = createOverlay({ document: page.document });
    overlay.render([issueOnCta()]);
    (page.document.querySelector('.fruitback-pin-badge') as HTMLElement).click();
    assert.equal(page.document.querySelectorAll('[data-fruitback-thread]').length, 1);

    page.document.querySelector('main')?.append(page.document.createElement('div'));
    await settle();

    assert.equal(page.document.querySelectorAll('[data-fruitback-thread]').length, 1, 'still open');
  });

  it('does not wake itself up on the pins it draws', async () => {
    // The default host is `<body>`, so the overlay's own DOM is inside what it observes. Without
    // the guard, drawing a pin schedules a resolution that draws a pin.
    const page = mountWithCta();
    let resolves = 0;
    overlay = createOverlay({ document: page.document, onResolve: () => (resolves += 1) });
    overlay.render([issueOnCta()]);

    await settle();

    assert.equal(resolves, 0);
  });

  it('costs nothing on a page with no pins', async () => {
    const page = mountWithCta();
    let resolves = 0;
    overlay = createOverlay({ document: page.document, onResolve: () => (resolves += 1) });
    overlay.render([]);

    page.document.querySelector('main')?.append(page.document.createElement('div'));
    await settle();

    assert.equal(resolves, 0);
  });
});

describe('coalescing the work', () => {
  it('resolves once for a burst of mutations, not once per mutation', async () => {
    const page = mountWithCta();
    let resolves = 0;
    overlay = createOverlay({ document: page.document, onResolve: () => (resolves += 1) });
    overlay.render([issueOnCta()]);

    // What a framework commit looks like from out here: several passes, close together.
    const main = page.document.querySelector('main');
    for (let pass = 0; pass < 5; pass += 1) {
      main?.append(page.document.createElement('div'));
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    await new Promise((resolve) => setTimeout(resolve, 250));

    assert.equal(resolves, 1);
  });

  it('still resolves on a page that never stops mutating', async () => {
    // The trap in restarting the timer on every mutation: a live feed or a spinner restarts it
    // indefinitely and the pins are never resolved. Hence the ceiling.
    const page = mountWithCta();
    let resolves = 0;
    overlay = createOverlay({ document: page.document, onResolve: () => (resolves += 1) });
    overlay.render([issueOnCta()]);

    const main = page.document.querySelector('main');
    const noisy = setInterval(() => main?.append(page.document.createElement('div')), 20);
    await new Promise((resolve) => setTimeout(resolve, 900));
    clearInterval(noisy);

    assert.ok(resolves >= 1, `never resolved under continuous mutation (${resolves})`);
  });
});

describe('showing only some pins', () => {
  it('draws only what the filter accepts, and can change its mind without new data', () => {
    // The filter belongs here rather than in the embedder for the same reason FRU-21's observer
    // does: on a client's site nobody is going to fetch the issues again to hide a stage.
    const page = mountWithCta();
    let hidden: string[] = [];
    overlay = createOverlay({
      document: page.document,
      shouldShow: (issue) => !hidden.includes(issue.stage),
    });

    overlay.render([issueOnCta({ stage: 'ripe' }), issueOnCta({ stage: 'seeded' })]);
    assert.equal(page.document.querySelectorAll('[data-fruitback-pin]').length, 2);

    hidden = ['ripe'];
    overlay.refilter();

    const stages = [...page.document.querySelectorAll('[data-fruitback-pin]')].map(
      (pin) => (pin as HTMLElement).dataset.fruitbackStage,
    );
    assert.deepEqual(stages, ['seeded']);

    // And back again, from the issues it kept rather than from a request.
    hidden = [];
    overlay.refilter();
    assert.equal(page.document.querySelectorAll('[data-fruitback-pin]').length, 2);
  });
});

describe('a note chosen in the list of the page (FRU-308)', () => {
  function two(page: MountedPage): Overlay {
    const made = createOverlay({ document: page.document });
    made.render([
      issueOnCta({ seed: { ...issueOnCta().seed, id: 'sd_one' } }),
      issueOnCta({ seed: { ...issueOnCta().seed, id: 'sd_two' } }),
    ]);

    return made;
  }
  const container = (page: MountedPage) => page.document.querySelector('[data-fruitback-overlay]') as HTMLElement;

  it('rings its element and sets the other pins back while its thread is in the list, and only then', () => {
    const page = mountWithCta();
    overlay = two(page);

    // A thread opened from its pin, on the page: no ring.
    overlay.select('sd_one');
    assert.equal(container(page).hasAttribute('data-fruitback-choosing'), false);

    const home = page.document.createElement('div');
    page.document.body.append(home);
    overlay.select('sd_two', home);
    assert.equal(container(page).hasAttribute('data-fruitback-choosing'), true);
    assert.equal(overlay.openId(), 'sd_two');

    overlay.closeThread();
    assert.equal(container(page).hasAttribute('data-fruitback-choosing'), false);
  });

  it('hides the pins and shows them again, the ring of the chosen note kept', () => {
    const page = mountWithCta();
    overlay = two(page);

    overlay.showPins(false);
    assert.equal(container(page).hasAttribute('data-fruitback-pins-hidden'), true);
    // The rule that hides them spares the open pin, its drop too: a thread open on the page keeps its pin.
    const style = [...page.document.querySelectorAll('style')].map((node) => node.textContent).join('');
    assert.match(
      style,
      /\[data-fruitback-pins-hidden\] \.fruitback-pin:not\(\[data-fruitback-open\]\) \{ display: none; \}/,
    );
    assert.doesNotMatch(style, /\[data-fruitback-pins-hidden\] \.fruitback-pin-badge/);
    overlay.showPins(true);
    assert.equal(container(page).hasAttribute('data-fruitback-pins-hidden'), false);
  });
});

describe('the issues it was handed', () => {
  it('keeps a copy, so a caller mutating their array does not change the screen', () => {
    const page = mountWithCta();
    overlay = createOverlay({ document: page.document });
    const issues = [issueOnCta()];

    overlay.render(issues);
    issues.push(issueOnCta());
    overlay.refilter();

    assert.equal(page.document.querySelectorAll('[data-fruitback-pin]').length, 1);
  });
});

describe('the team’s replies', () => {
  it('shows them oldest first, with who wrote each', () => {
    const page = mountWithCta();
    overlay = createOverlay({ document: page.document });
    overlay.render([
      issueOnCta({
        comments: [
          { id: 'c1', body: 'On regarde ça.', createdAt: '2026-08-01T10:00:00.000Z', author: 'Alice' },
          { id: 'c2', body: 'Corrigé sur la préprod.', createdAt: '2026-08-02T10:00:00.000Z', author: 'Bruno' },
        ],
      }),
    ]);
    (page.document.querySelector('.fruitback-pin-badge') as HTMLElement).click();

    const bodies = [...page.document.querySelectorAll('.fruitback-thread-reply-body')].map((node) => node.textContent);
    assert.deepEqual(bodies, ['On regarde ça.', 'Corrigé sur la préprod.']);
    assert.match(page.document.querySelector('.fruitback-thread-reply-who')?.textContent ?? '', /Alice/);
    // The list scrolls, so a keyboard must be able to stop on it, and the stop has a name (FRU-154).
    const list = page.document.querySelector('.fruitback-thread-replies');
    assert.equal(list?.getAttribute('tabindex'), '0');
    assert.equal(list?.getAttribute('aria-label'), 'Replies');
  });

  it('renders a reply as text, never as markup', () => {
    // Linear markdown, written by anyone who can comment on the issue, rendered inside a client's
    // page. Treating it as HTML would make the feedback widget the way into their site.
    const page = mountWithCta();
    overlay = createOverlay({ document: page.document });
    overlay.render([
      issueOnCta({
        comments: [{ id: 'c1', body: '<img src=x onerror="alert(1)">', createdAt: '2026-08-01T10:00:00.000Z' }],
      }),
    ]);
    (page.document.querySelector('.fruitback-pin-badge') as HTMLElement).click();

    const body = page.document.querySelector('.fruitback-thread-reply-body');
    assert.equal(body?.textContent, '<img src=x onerror="alert(1)">');
    assert.equal(body?.querySelector('img'), null);
  });

  it('says nothing at all when the worker did not fetch replies', () => {
    // Absent is not empty. "No reply yet" would be a claim the widget cannot make when it
    // was never told — a client with comments switched off would be told its team never answered.
    const page = mountWithCta();
    overlay = createOverlay({ document: page.document });
    overlay.render([issueOnCta({ comments: undefined })]);
    (page.document.querySelector('.fruitback-pin-badge') as HTMLElement).click();

    assert.equal(page.document.querySelector('.fruitback-thread-empty'), null);
    assert.equal(page.document.querySelector('.fruitback-thread-replies'), null);
  });

  it('says so when it asked and there were none', () => {
    const page = mountWithCta();
    overlay = createOverlay({ document: page.document });
    overlay.render([issueOnCta({ comments: [] })]);
    (page.document.querySelector('.fruitback-pin-badge') as HTMLElement).click();

    assert.match(page.document.querySelector('.fruitback-thread-empty')?.textContent ?? '', /No reply yet/);
  });
});

describe('the reading direction and the dates (FRU-38)', () => {
  it('opens the thread 26 px past the point of the drop, on its end side, or on the other one (FRU-304)', () => {
    const placedBy = (left: number, translator = createTranslator()) => {
      const page = mountWithCta();
      setRect(page.query('button'), { left, top: 200, width: 200, height: 40 });
      overlay = createOverlay({ document: page.document, translator });
      overlay.render([issueOnCta()]);
      (page.document.querySelector('.fruitback-pin-badge') as HTMLElement).click();
      const pin = page.document.querySelector('[data-fruitback-pin]') as HTMLElement;
      const thread = page.document.querySelector('[data-fruitback-thread]') as HTMLElement;
      const placed = { pin: pin.style.left, left: thread.style.left, top: thread.style.top };
      overlay.destroy();
      overlay = null;

      return placed;
    };
    const hebrew = createTranslator({ locale: 'he', messages: { he: { 'thread.close': 'סגור' } } });

    // The point is at 116, 200: the thread starts 26 px past it, 8 px above the top of the drop (200 − 34 − 8).
    assert.deepEqual(placedBy(100), { pin: '95px', left: '142px', top: '158px' });
    // Right to left, the end side is the left one: 616 − 26 − 344.
    assert.deepEqual(placedBy(600, hebrew), { pin: '595px', left: '246px', top: '158px' });
    // No room on the end side: the other one, 716 − 26 − 344. The pin is geometry and does not move.
    assert.deepEqual(placedBy(700), { pin: '695px', left: '346px', top: '158px' });
    assert.deepEqual(placedBy(100, hebrew), { pin: '95px', left: '142px', top: '158px' });
  });

  it('opens the thread under its pin when the window has no room on either side', () => {
    // A phone: 390 px leave no room for 344 px and 26 px on either side of the point.
    const page = mountPage(PAGE, { width: 390, height: 844 });
    setDocumentSize(page.document, 390, 844);
    setRect(page.query('button'), { left: 100, top: 200, width: 200, height: 40 });
    overlay = createOverlay({ document: page.document });
    overlay.render([issueOnCta()]);
    (page.document.querySelector('.fruitback-pin-badge') as HTMLElement).click();
    const thread = page.document.querySelector('[data-fruitback-thread]') as HTMLElement;
    // Under the frame (195 + 50 + 8), and inside the window: 390 − 344 − 8.
    assert.deepEqual({ left: thread.style.left, top: thread.style.top }, { left: '38px', top: '253px' });
  });

  it('opens the thread inside the window when the page is scrolled sideways (FRU-68)', () => {
    const placedBy = (viewportLeft: number, translator = createTranslator()) => {
      const page = mountWithCta();
      page.view.scrollTo(1_500, 0);
      setRect(page.query('button'), { left: viewportLeft, top: 200, width: 200, height: 40 });
      overlay = createOverlay({ document: page.document, translator });
      overlay.render([issueOnCta()]);
      (page.document.querySelector('.fruitback-pin-badge') as HTMLElement).click();
      const pin = page.document.querySelector('[data-fruitback-pin]') as HTMLElement;
      const thread = page.document.querySelector('[data-fruitback-thread]') as HTMLElement;
      const placed = { pin: pin.style.left, thread: thread.style.left };
      overlay.destroy();
      overlay = null;

      return placed;
    };

    // On screen at document x 2000: past the point, counted from the scroll (2016 + 26).
    assert.deepEqual(placedBy(500), { pin: '1995px', thread: '2042px' });
    // Near the right edge of the window, on the other side of the point: 2416 − 26 − 344.
    assert.deepEqual(placedBy(900), { pin: '2395px', thread: '2046px' });
    // Right to left, near the left edge of the window, on the end side after all: 1516 + 26.
    assert.deepEqual(placedBy(0, createTranslator({ locale: 'he', messages: { he: { 'thread.close': 'סגור' } } })), {
      pin: '1495px',
      thread: '1542px',
    });
  });

  it('dates a reply relative to now, with the day in its title', () => {
    const page = mountWithCta();
    const translator = createTranslator({ now: () => Date.parse('2026-08-02T10:00:00.000Z') });
    overlay = createOverlay({ document: page.document, translator });
    overlay.render([
      issueOnCta({
        comments: [
          { id: 'c1', body: 'Seen.', createdAt: '2026-08-01T10:00:00.000Z', author: 'Alice' },
          { id: 'c2', body: 'Odd date.', createdAt: 'last tuesday', author: 'Bruno' },
        ],
      }),
    ]);
    (page.document.querySelector('.fruitback-pin-badge') as HTMLElement).click();

    const [first, second] = [...page.document.querySelectorAll('.fruitback-thread-reply-who')] as HTMLElement[];
    assert.equal(first?.textContent, 'Alice · yesterday');
    assert.equal(first?.title, new Date('2026-08-01T10:00:00.000Z').toLocaleDateString('en'));
    // A date the store wrote in a shape Date cannot read is shown as it came, not as "Invalid Date".
    assert.equal(second?.textContent, 'Bruno · last tuesday');
  });
});

describe('the detached notes', () => {
  const orphanIssue = (note: string) =>
    seedIssueFixture({
      seed: seedFixture({
        note,
        anchor: {
          selector: '#gone-for-good',
          // A tag this page does not have, so even `bounds` — which scores overlap against every
          // element of the same tag — has nothing to score. That is what "detached" means.
          tag: 'textarea',
          text: 'Disparu',
          bounds: { xPct: 10, yPct: 20, wPct: 20, hPct: 4 },
        },
      }),
    });

  it('stays out of the way when every pin found its element', () => {
    // A widget that puts an empty drawer on someone else's site is one they turn off.
    const page = mountWithCta();
    overlay = createOverlay({ document: page.document });
    overlay.render([issueOnCta()]);

    assert.equal((page.document.querySelector('[data-fruitback-orphans]') as HTMLElement).hidden, true);
  });

  it('lists a note whose element the cascade could not find at all', () => {
    const page = mountWithCta();
    overlay = createOverlay({ document: page.document });
    overlay.render([orphanIssue('La carte que le redesign a supprimée')]);

    const drawer = page.document.querySelector('[data-fruitback-orphans]') as HTMLElement;
    assert.equal(drawer.hidden, false);
    assert.match(drawer.querySelector('.fruitback-orphans-toggle')?.textContent ?? '', /1 detached note/);
    assert.match(
      drawer.querySelector('.fruitback-orphans-note')?.textContent ?? '',
      /La carte que le redesign a supprimée/,
    );
  });

  it('does not list a pin that was placed by position', () => {
    // The line this whole ticket had to be re-scoped around: a pin found only by `bounds` is still
    // on the page, dashed and marked unsure (FRU-11). It is not detached, and listing it here would
    // be telling the reporter their note is lost when it is sitting on the right element.
    const page = mountWithCta();
    overlay = createOverlay({ document: page.document });
    overlay.render([
      seedIssueFixture({
        seed: seedFixture({
          anchor: {
            selector: '#not-here',
            tag: 'button',
            // Text that is on no element here either, so `bounds` really is the last strategy left —
            // and it resolves, by overlapping the button's box.
            text: 'Un libellé que la page n’a plus',
            bounds: { xPct: 10, yPct: 20, wPct: 20, hPct: 4 },
          },
        }),
      }),
    ]);

    const listed = page.document.querySelectorAll('.fruitback-orphans-item').length;
    const pin = page.document.querySelector('[data-fruitback-pin]') as HTMLElement;

    // The fixture has to land on `bounds` for this test to mean anything: on `selector` or `text` it
    // would be confident, and the hardened version this guards against would not have listed it.
    assert.equal(pin.dataset.fruitbackStrategy, 'bounds');
    assert.equal(pin.dataset.fruitbackConfident, 'false');
    assert.equal(listed, 0);
  });

  it('empties and hides itself once the element is back', () => {
    const page = mountWithCta();
    overlay = createOverlay({ document: page.document });
    overlay.render([orphanIssue('Temporairement introuvable')]);
    assert.equal((page.document.querySelector('[data-fruitback-orphans]') as HTMLElement).hidden, false);

    overlay.render([issueOnCta()]);

    const drawer = page.document.querySelector('[data-fruitback-orphans]') as HTMLElement;
    assert.equal(drawer.hidden, true);
    assert.equal(drawer.querySelectorAll('.fruitback-orphans-item').length, 0);
  });

  it('opens the note when its entry is clicked', () => {
    const page = mountWithCta();
    overlay = createOverlay({ document: page.document });
    overlay.render([orphanIssue('Ouvre-moi')]);

    (page.document.querySelector('.fruitback-orphans-note') as HTMLElement).click();

    assert.equal(page.document.querySelectorAll('[data-fruitback-thread]').length, 1);
  });

  it('takes its DOM with it when the overlay is destroyed', () => {
    const page = mountWithCta();
    overlay = createOverlay({ document: page.document });
    overlay.render([orphanIssue('Adieu')]);

    overlay.destroy();
    overlay = null;

    assert.equal(page.document.querySelector('[data-fruitback-orphans]'), null);
  });
});

describe('the detached list is the widget’s own DOM', () => {
  it('does not wake the observer by drawing itself', async () => {
    // The list is a sibling of the overlay's container, not a child, so the `isOurs` guard did not
    // cover it: rebuilding it on every resolve mutated the document, which scheduled another
    // resolve, which rebuilt it again.
    const page = mountWithCta();
    let resolves = 0;
    overlay = createOverlay({ document: page.document, onResolve: () => (resolves += 1) });
    overlay.render([
      seedIssueFixture({
        seed: seedFixture({
          anchor: {
            selector: '#gone-for-good',
            tag: 'textarea',
            text: 'Disparu',
            bounds: { xPct: 10, yPct: 20, wPct: 20, hPct: 4 },
          },
        }),
      }),
    ]);

    await new Promise((resolve) => setTimeout(resolve, 400));

    assert.equal(resolves, 0);
  });
});

describe('the thread and the keyboard (FRU-51)', () => {
  function openOnCta(): { page: MountedPage; badge: HTMLElement } {
    const page = mountWithCta();
    overlay = createOverlay({ document: page.document });
    overlay.render([issueOnCta()]);
    const badge = page.document.querySelector('.fruitback-pin-badge') as HTMLElement;
    badge.click();

    return { page, badge };
  }

  it('opens as a named dialog, with focus on its close button', () => {
    const { page } = openOnCta();
    const thread = page.document.querySelector('[data-fruitback-thread]');

    assert.equal(thread?.getAttribute('role'), 'dialog');
    // The number its drop carries (FRU-256), so the pin and its dialog name the same note.
    assert.equal(thread?.getAttribute('aria-label'), 'Note 1');
    assert.ok(page.document.activeElement?.classList.contains('fruitback-thread-close'));
  });

  it('gives focus back to the badge on Escape', () => {
    const { page, badge } = openOnCta();

    pressKey(page, 'Escape');

    assert.ok(page.document.querySelector('[data-fruitback-thread]') === null, 'the thread is still open');
    assert.ok(page.document.activeElement === badge, 'focus did not go back to the badge');
  });

  it('keeps focus on the pin when a render rebuilds the pins under a focused thread', () => {
    const { page } = openOnCta();

    overlay?.render([issueOnCta()]);

    const badge = page.document.querySelector('.fruitback-pin-badge');
    assert.ok(badge !== null && page.document.activeElement === badge, 'focus fell to the page');
  });

  it('keeps focus on a badge that a render replaces', () => {
    const page = mountWithCta();
    overlay = createOverlay({ document: page.document });
    overlay.render([issueOnCta()]);
    const before = page.document.querySelector('.fruitback-pin-badge') as HTMLElement;
    before.focus();

    overlay.render([issueOnCta()]);

    const after = page.document.querySelector('.fruitback-pin-badge');
    assert.ok(after !== null && after !== before, 'the render did not rebuild the badge');
    assert.ok(page.document.activeElement === after, 'focus stayed on the removed badge');
  });

  it('moves no focus on a render when the overlay did not have it', () => {
    const page = mountWithCta();
    overlay = createOverlay({ document: page.document });
    overlay.render([issueOnCta()]);
    const cta = page.query('button') as HTMLButtonElement;
    cta.focus();

    overlay.render([issueOnCta()]);

    assert.ok(page.document.activeElement === cta, 'the render took focus from the page');
  });

  it('gives focus back to the detached-note entry that opened the thread', () => {
    const page = mountWithCta();
    overlay = createOverlay({ document: page.document });
    overlay.render([
      seedIssueFixture({
        seed: seedFixture({
          id: 'sd_gone',
          note: 'Disparu',
          anchor: {
            selector: '#gone',
            tag: 'textarea',
            text: 'Disparu',
            bounds: { xPct: 10, yPct: 20, wPct: 20, hPct: 4 },
          },
        }),
      }),
    ]);
    const entry = page.document.querySelector('.fruitback-orphans-note') as HTMLButtonElement;
    assert.ok(entry !== null, 'the note is not listed as detached');

    entry.focus();
    entry.click();
    assert.ok(page.document.querySelector('[data-fruitback-thread]') !== null, 'the entry opened no thread');
    pressKey(page, 'Escape');

    assert.ok(
      page.document.activeElement === entry,
      'focus went to the pin instead of the entry that opened the thread',
    );
  });

  it('places the thread of a detached note from the position its hidden pin keeps (FRU-304)', () => {
    const page = mountWithCta();
    overlay = createOverlay({ document: page.document });
    overlay.render([
      seedIssueFixture({
        seed: seedFixture({
          id: 'sd_gone',
          note: 'Disparu',
          anchor: {
            selector: '#gone',
            tag: 'textarea',
            text: 'Disparu',
            bounds: { xPct: 10, yPct: 20, wPct: 20, hPct: 4 },
          },
        }),
      }),
    ]);
    // The drop of a detached note is not drawn on the page: the chip of the dock lists it.
    const pin = page.document.querySelector('.fruitback-pin-orphan') as HTMLElement;
    assert.ok(pin !== null, 'the detached note has no pin');
    // Its place is written on it all the same, and the thread is measured from that, not from a box.
    assert.ok(Number.parseFloat(pin.style.left) > 0 && Number.parseFloat(pin.style.top) > 0, 'the pin has no place');

    (page.document.querySelector('.fruitback-orphans-note') as HTMLButtonElement).click();
    const thread = page.document.querySelector('[data-fruitback-thread]') as HTMLElement;
    assert.ok(thread !== null, 'the entry opened no thread');
    assert.ok(Number.parseFloat(thread.style.left) > 0, 'the thread is at the left edge');
    assert.ok(Number.parseFloat(thread.style.top) > 0, 'the thread is at the top edge');
  });

  it('keeps focus on the detached-note entry across a render, for its thread and for the entry itself', () => {
    const page = mountWithCta();
    const detached = (id: string, note: string) =>
      seedIssueFixture({
        seed: seedFixture({
          id,
          note,
          anchor: {
            selector: `#${id}`,
            tag: 'textarea',
            text: note,
            bounds: { xPct: 10, yPct: 20, wPct: 20, hPct: 4 },
          },
        }),
      });
    const entryFor = (note: string) =>
      [...page.document.querySelectorAll('.fruitback-orphans-note')].find((node) => node.textContent === note);
    overlay = createOverlay({ document: page.document });
    overlay.render([detached('sd_gone', 'Disparu')]);

    const opener = entryFor('Disparu') as HTMLButtonElement;
    opener.focus();
    opener.click();
    overlay.render([detached('sd_gone', 'Disparu')]);
    assert.ok(page.document.activeElement === entryFor('Disparu'), 'a render under the thread moved focus to the pin');

    overlay.render([detached('sd_gone', 'Disparu'), detached('sd_other', 'Autre')]);
    const rebuilt = entryFor('Disparu');
    assert.ok(rebuilt !== undefined && rebuilt !== opener, 'the list was not rebuilt, so this checks nothing');
    assert.ok(page.document.activeElement === rebuilt, 'a rebuilt list dropped the focus of its entry');
  });

  it('leaves focus on the page when a click outside closes it', () => {
    const { page } = openOnCta();
    const cta = page.query('button') as HTMLButtonElement;

    cta.focus();
    cta.click();

    assert.ok(page.document.querySelector('[data-fruitback-thread]') === null, 'the thread is still open');
    assert.ok(page.document.activeElement === cta, 'the close took focus from the page');
  });
});

describe('the name of a pin, cut at the end of a word (FRU-320)', () => {
  it('keeps a short note whole, and cuts a long one at a space near 60 characters', async () => {
    const { shortened } = await import('./overlay.ts');

    assert.equal(shortened('Le bouton est trop bas', 60), 'Le bouton est trop bas');
    const cut = shortened('Le prix du Latte devrait être 18 €, pas 19 €, comme sur la carte du comptoir.', 60);
    assert.equal(cut, 'Le prix du Latte devrait être 18 €, pas 19 €, comme sur la…');
    assert.ok(cut.length <= 60);
    // The number that mattered survives the cut, which it did not at 32 characters.
    assert.match(cut, /18 €/);
    // A word longer than half of the room is cut inside, rather than leaving a name of three letters.
    assert.equal(shortened(`Ok ${'x'.repeat(80)}`, 60), `Ok ${'x'.repeat(56)}…`);
    // No dangling comma before the ellipsis.
    assert.equal(shortened('aaaa bbbb, cccc dddd', 12), 'aaaa bbbb…');
  });
});
