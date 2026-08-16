import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SEED_STAGE_STYLES } from '@fruitback/shared';
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

    const pin = page.document.querySelector('[data-fb-pin]') as HTMLElement;
    assert.equal(pin.style.left, '100px');
    assert.equal(pin.style.top, '200px');
    assert.equal(pin.style.width, '200px');
    assert.equal(pin.style.height, '40px');
    assert.equal(pin.dataset.fbStrategy, 'selector');
  });

  it('colours the pin by the Linear state, not by anything it stores itself', () => {
    const page = mountWithCta();
    overlay = createOverlay({ document: page.document });

    overlay.render([issueOnCta({ stage: 'ripe', stateName: 'Done' })]);

    const pin = page.document.querySelector('[data-fb-pin]') as HTMLElement;
    assert.equal(pin.dataset.fbStage, 'ripe');
    assert.equal(pin.style.getPropertyValue('--fb-pin-color'), SEED_STAGE_STYLES.ripe.color);
  });

  it('places a pin whose element is gone at its remembered position, and says so', () => {
    const page = mountWithCta();
    page.query('button').remove();
    overlay = createOverlay({ document: page.document });

    overlay.render([issueOnCta()]);

    const pin = page.document.querySelector('[data-fb-pin]') as HTMLElement;
    assert.equal(pin.dataset.fbStrategy, 'orphan');
    assert.ok(pin.className.includes('fb-pin-orphan'));
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

    const pin = page.document.querySelector('[data-fb-pin]') as HTMLElement;
    assert.equal(pin.dataset.fbStrategy, 'bounds');
    assert.equal(pin.dataset.fbConfident, 'false');
    assert.ok(pin.className.includes('fb-pin-uncertain'));
    assert.match(page.document.querySelector('.fb-pin-badge')?.textContent ?? '', /≈/);

    (page.document.querySelector('.fb-pin-badge') as HTMLElement).click();
    assert.match(page.document.querySelector('[data-fb-thread]')?.textContent ?? '', /par sa position/i);
  });

  it('re-measures when the page moves under it', () => {
    const page = mountWithCta();
    overlay = createOverlay({ document: page.document });
    overlay.render([issueOnCta()]);

    // A banner appeared above and pushed everything down.
    setRect(page.query('button'), { left: 100, top: 460, width: 200, height: 40 });
    overlay.reposition();

    assert.equal((page.document.querySelector('[data-fb-pin]') as HTMLElement).style.top, '460px');
  });

  it('falls back to the remembered box when the element is torn out of the page', () => {
    // An SPA re-renders and the node we resolved is detached. A detached node measures 0×0, which
    // would slide the pin into the top-left corner and read as a bug in the overlay.
    const page = mountWithCta();
    overlay = createOverlay({ document: page.document });
    overlay.render([issueOnCta()]);

    page.query('button').remove();
    overlay.reposition();

    const pin = page.document.querySelector('[data-fb-pin]') as HTMLElement;
    assert.equal(pin.style.left, '100px');
    assert.equal(pin.style.top, '200px');
    assert.ok(pin.className.includes('fb-pin-orphan'), 'the pin should show that it lost its element');
  });

  it('does not close the thread when the click is inside it', () => {
    const page = mountWithCta();
    overlay = createOverlay({ document: page.document });
    overlay.render([issueOnCta()]);
    (page.document.querySelector('.fb-pin-badge') as HTMLElement).click();

    (page.document.querySelector('.fb-thread-note') as HTMLElement).click();

    assert.ok(page.document.querySelector('[data-fb-thread]'), 'the thread closed under its own click');
  });

  it('lets clicks through to the page, except on the badge', () => {
    // A widget that swallows the client's own buttons is one they turn off.
    const page = mountWithCta();
    overlay = createOverlay({ document: page.document });
    overlay.render([issueOnCta()]);

    const pin = page.document.querySelector('.fb-pin') as HTMLElement;
    const badge = page.document.querySelector('.fb-pin-badge') as HTMLElement;
    const styles = page.view.getComputedStyle(pin);

    assert.equal(styles.pointerEvents, 'none');
    assert.equal(page.view.getComputedStyle(badge).pointerEvents, 'auto');
  });

  it('opens the thread on the badge: the note, the state and the way to Linear', () => {
    const page = mountWithCta();
    overlay = createOverlay({ document: page.document });
    overlay.render([issueOnCta({ identifier: 'SKG-742', stateName: 'In Progress' })]);

    (page.document.querySelector('.fb-pin-badge') as HTMLElement).click();

    const thread = page.document.querySelector('[data-fb-thread]');
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

    (page.document.querySelector('.fb-pin-badge') as HTMLElement).click();

    assert.match(page.document.querySelector('[data-fb-thread]')?.textContent ?? '', /introuvable/i);
  });

  it('closes the thread on Escape', () => {
    const page = mountWithCta();
    overlay = createOverlay({ document: page.document });
    overlay.render([issueOnCta()]);
    (page.document.querySelector('.fb-pin-badge') as HTMLElement).click();

    pressKey(page, 'Escape');

    assert.equal(page.document.querySelector('[data-fb-thread]'), null);
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

    assert.equal(page.document.querySelector('[data-fb-pin]'), null);
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
    const before = page.document.querySelector('[data-fb-pin]') as HTMLElement;
    assert.equal(before.dataset.fbStrategy, 'selector');

    // What React does on a re-render: the old node goes, an equivalent one takes its place
    // elsewhere on the page.
    page.query('button').remove();
    const replacement = page.document.createElement('button');
    replacement.dataset.testid = 'checkout-cta';
    replacement.textContent = 'Commander';
    page.document.querySelector('main')?.append(replacement);
    setRect(replacement, { left: 400, top: 600, width: 200, height: 40 });

    await settle();

    const pin = page.document.querySelector('[data-fb-pin]') as HTMLElement;
    assert.equal(pin.style.left, '400px', 'the pin followed its element');
    assert.equal(pin.style.top, '600px');
    assert.deepEqual(resolved, ['selector'], 'and the host was told, rather than asked to notice');
  });

  it('stops claiming to be sure when the element it recognised is gone', async () => {
    const page = mountWithCta();
    overlay = createOverlay({ document: page.document });
    overlay.render([issueOnCta()]);

    const pin = page.document.querySelector('[data-fb-pin]') as HTMLElement;
    assert.equal(pin.dataset.fbConfident, 'true');

    page.query('button').remove();
    await settle();

    // Re-resolved in place: the same pin element, carrying different marks.
    assert.equal(pin.dataset.fbConfident, 'false');
    assert.equal(pin.querySelector('.fb-pin-glyph')?.textContent, '≈');
    assert.ok(pin.classList.contains('fb-pin-uncertain'));
  });

  it('does not close a thread someone is reading', async () => {
    // `render` rebuilds and would close it. A page mutating while a note is open is normal on an
    // SPA.
    const page = mountWithCta();
    overlay = createOverlay({ document: page.document });
    overlay.render([issueOnCta()]);
    (page.document.querySelector('.fb-pin-badge') as HTMLElement).click();
    assert.equal(page.document.querySelectorAll('[data-fb-thread]').length, 1);

    page.document.querySelector('main')?.append(page.document.createElement('div'));
    await settle();

    assert.equal(page.document.querySelectorAll('[data-fb-thread]').length, 1, 'still open');
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
    assert.equal(page.document.querySelectorAll('[data-fb-pin]').length, 2);

    hidden = ['ripe'];
    overlay.refilter();

    const stages = [...page.document.querySelectorAll('[data-fb-pin]')].map(
      (pin) => (pin as HTMLElement).dataset.fbStage,
    );
    assert.deepEqual(stages, ['seeded']);

    // And back again, from the issues it kept rather than from a request.
    hidden = [];
    overlay.refilter();
    assert.equal(page.document.querySelectorAll('[data-fb-pin]').length, 2);
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

    assert.equal(page.document.querySelectorAll('[data-fb-pin]').length, 1);
  });
});
