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
