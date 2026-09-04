import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { seedFixture, seedIssueFixture } from '@fruitback/shared/seed.fixture';
import { type Overlay, createOverlay } from './overlay.ts';
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
    assert.equal(pin.style.left, '100px');
    assert.equal(pin.style.top, '200px');
    assert.equal(pin.style.width, '200px');
    assert.equal(pin.style.height, '40px');
    assert.equal(pin.dataset.fruitbackStrategy, 'selector');
  });

  it('colours the pin by the Linear state, not by anything it stores itself', () => {
    const page = mountWithCta();
    overlay = createOverlay({ document: page.document });

    overlay.render([issueOnCta({ stage: 'ripe', stateName: 'Done' })]);

    const pin = page.document.querySelector('[data-fruitback-pin]') as HTMLElement;
    assert.equal(pin.dataset.fruitbackStage, 'ripe');
    // The token, not the hexadecimal (SKG-528). What the pin actually renders is asserted end to
    // end in `e2e/overlay.spec.ts`, which reads the computed colour in a real browser — the only
    // place a `var()` can be resolved at all.
    assert.equal(pin.style.getPropertyValue('--fruitback-pin-color'), 'var(--fruitback-stage-ripe)');
  });

  it('places a pin whose element is gone at its remembered position, and says so', () => {
    const page = mountWithCta();
    page.query('button').remove();
    overlay = createOverlay({ document: page.document });

    overlay.render([issueOnCta()]);

    const pin = page.document.querySelector('[data-fruitback-pin]') as HTMLElement;
    assert.equal(pin.dataset.fruitbackStrategy, 'orphan');
    assert.ok(pin.className.includes('fruitback-pin-orphan'));
    // 10% of 1000 across, 20% down: the box the note was planted on.
    assert.equal(pin.style.left, '100px');
    assert.equal(pin.style.top, '200px');
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
    assert.match(page.document.querySelector('.fruitback-pin-badge')?.textContent ?? '', /≈/);

    (page.document.querySelector('.fruitback-pin-badge') as HTMLElement).click();
    assert.match(page.document.querySelector('[data-fruitback-thread]')?.textContent ?? '', /par sa position/i);
  });

  it('re-measures when the page moves under it', () => {
    const page = mountWithCta();
    overlay = createOverlay({ document: page.document });
    overlay.render([issueOnCta()]);

    // A banner appeared above and pushed everything down.
    setRect(page.query('button'), { left: 100, top: 460, width: 200, height: 40 });
    overlay.reposition();

    assert.equal((page.document.querySelector('[data-fruitback-pin]') as HTMLElement).style.top, '460px');
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
    assert.equal(pin.style.left, '100px');
    assert.equal(pin.style.top, '200px');
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

  it('falls back to the stage when the store reports no state name (SKG-517)', () => {
    // The Linear connector reports `node.state?.name ?? ''`, so an issue with no state gives an empty
    // string. That used to leave a lone glyph in the header; with the glyph gone it would leave an
    // empty span — a thread whose top row is just a close button. Raised in review.
    const page = mountWithCta();
    overlay = createOverlay({ document: page.document });
    overlay.render([issueOnCta({ stateName: '', stage: 'ripening' })]);

    (page.document.querySelector('.fruitback-pin-badge') as HTMLElement).click();

    const header = page.document.querySelector('.fruitback-thread-stage');
    assert.equal(header?.textContent, 'Ripening');
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
    // The label said "sur Linear" until SKG-524, in a widget that is not supposed to know what is
    // behind the worker — the same defect `store-unavailable` fixed in the error codes.
    const page = mountWithCta();
    overlay = createOverlay({ document: page.document });
    overlay.render([issueOnCta({ identifier: 'SKG-742' })]);

    (page.document.querySelector('.fruitback-pin-badge') as HTMLElement).click();

    const link = page.document.querySelector('[data-fruitback-thread] a');
    assert.match(link?.textContent ?? '', /SKG-742/);
    assert.doesNotMatch(link?.textContent ?? '', /Linear/);
  });

  it('draws no link at all when the store has nowhere to open (SKG-524)', () => {
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

    assert.match(page.document.querySelector('[data-fruitback-thread]')?.textContent ?? '', /introuvable/i);
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
    assert.equal(pin.style.left, '400px', 'the pin followed its element');
    assert.equal(pin.style.top, '600px');
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
    assert.equal(pin.querySelector('.fruitback-pin-glyph')?.textContent, '≈');
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
    // The filter belongs here rather than in the embedder for the same reason SKG-513's observer
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
    // Absent is not empty. "Pas encore de réponse" would be a claim the widget cannot make when it
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

    assert.match(page.document.querySelector('.fruitback-thread-empty')?.textContent ?? '', /Pas encore/);
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
    assert.match(drawer.querySelector('.fruitback-orphans-toggle')?.textContent ?? '', /1 note détachée/);
    assert.match(
      drawer.querySelector('.fruitback-orphans-note')?.textContent ?? '',
      /La carte que le redesign a supprimée/,
    );
  });

  it('does not list a pin that was placed by position', () => {
    // The line this whole ticket had to be re-scoped around: a pin found only by `bounds` is still
    // on the page, dashed and marked unsure (SKG-500). It is not detached, and listing it here would
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
