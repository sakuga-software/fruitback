import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { type CaptureEngine } from './engine.ts';
import { type CaptureHost, type CaptureTarget, createCaptureHost } from './host.ts';
import { type MountedPage, mouseEventCtor, mountPage, pressKey } from './dom.fixture.ts';

/**
 * The engine is faked here on purpose. happy-dom has no layout and no `elementsFromPoint`, so asking
 * it to hit-test would test happy-dom; what these check is the host's own behaviour — what it puts in
 * the Shadow root, what it refuses to point at, and what it hands back.
 */

const PAGE = '<main><button id="cta">Commander</button><p id="prose">Du texte</p></main>';

let host: CaptureHost | null = null;

afterEach(() => {
  host?.destroy();
  host = null;
});

/** Reports whatever element the test says is under the pointer, minus what the host rejects. */
function fakeEngine(page: MountedPage, under: () => Element | null): CaptureEngine & { rejected: Element[] } {
  const rejected: Element[] = [];

  return {
    rejected,
    elementAt(_x, _y, reject) {
      const element = under();
      if (element === null) return null;
      if (reject(element)) {
        rejected.push(element);
        return null;
      }

      return element;
    },
    boundsOf: () => ({ left: 10, top: 20, width: 100, height: 30 }),
    sourceOf: async () => ({ component: 'CheckoutCta', file: 'src/cta.tsx', line: 12 }),
  };
}

function mount(
  under: () => Element | null,
  onSelect: (target: CaptureTarget) => void = () => {},
  extra: Partial<Parameters<typeof createCaptureHost>[0]> = {},
) {
  const page = mountPage(PAGE, { width: 1_000, height: 1_000 });
  const engine = fakeEngine(page, under);
  host = createCaptureHost({ document: page.document, engine, onSelect, ...extra });

  return { page, engine };
}

const clickAt = (page: MountedPage, target: Element) =>
  target.dispatchEvent(new (mouseEventCtor(page))('click', { bubbles: true, composed: true, clientX: 5, clientY: 5 }));

const moveOver = (page: MountedPage) =>
  page.document.dispatchEvent(new (mouseEventCtor(page))('mousemove', { bubbles: true, clientX: 5, clientY: 5 }));

/** The host is non-null in every test that reaches for it; `mount` has just built it. */
function launchButton(): HTMLElement {
  const button = host?.root.querySelector('[data-fruitback-host-launch]');
  assert.ok(button, 'the launch button is missing');

  return button as HTMLElement;
}

describe('the chrome the reporter sees (SKG-529)', () => {
  it('names the launch button in words, and draws the seed as a shape', () => {
    // The label used to open with a sprout. An emoji is drawn by the system font, so nothing about
    // it is ours to set — and the accessible name is the label, which is what every E2E spec finds
    // this button by, so the icon has to contribute no text at all.
    mount(() => null);
    const button = launchButton();

    assert.equal(button.textContent, 'Laisser un feedback');
    assert.ok(button.querySelector('svg.fruitback-icon'), 'the launch button lost its mark');
  });

  it('keeps the mark when the embedder supplies its own label', () => {
    // The label is a string a host passes; setting it through textContent would have taken the icon
    // out with it, which is why the two live in separate nodes.
    mount(
      () => null,
      () => {},
      { label: 'Leave feedback' },
    );
    const button = launchButton();

    assert.equal(button.textContent, 'Leave feedback');
    assert.ok(button.querySelector('svg.fruitback-icon'), 'a custom label removed the mark');
  });

  it('restores the label after a capture, mark included', () => {
    mount(() => null);

    host?.start();
    assert.equal(launchButton().textContent, 'Échap pour annuler');

    host?.stop();
    assert.equal(launchButton().textContent, 'Laisser un feedback');
    assert.ok(launchButton().querySelector('svg.fruitback-icon'), 'stopping a capture removed the mark');
  });

  it('gives the gear a drawing and a name, and no character', () => {
    mount(
      () => null,
      () => {},
      { onConfigure: () => {} },
    );
    const gear = host?.root.querySelector('[data-fruitback-host-configure]');

    assert.ok(gear?.querySelector('svg.fruitback-icon'), 'the gear is not drawn');
    assert.equal(gear?.textContent, '', 'the gear still carries a character');
    assert.equal(gear?.getAttribute('aria-label'), 'Ouvrir les réglages Fruitback');
  });

  it('stops the reset at the edge of an SVG, or every icon renders empty', () => {
    // Measured in Chromium: under a bare star selector, a path computes d:none and stroke:none —
    // the geometry is a CSS property since SVG2, so all:initial erases the drawing. Nothing throws,
    // nothing logs, and every icon in the widget is an empty box. happy-dom draws nothing, so this
    // asserts the selector; `e2e/host.spec.ts` asserts the pixels.
    const { page } = mount(() => null);
    const sheet = page.document.querySelector('[data-fruitback-host]')?.shadowRoot?.querySelector('style');

    assert.match(sheet?.textContent ?? '', /\*:not\(svg, svg \*\) \{ all: initial;/);
  });
});

describe('createCaptureHost', () => {
  it('puts everything it draws inside a Shadow root', () => {
    // The whole point: the client's CSS cannot reach in, and ours cannot leak out.
    const { page } = mount(() => null);

    const container = page.document.querySelector('[data-fruitback-host]');
    assert.ok(container, 'no host element');
    assert.ok(container.shadowRoot, 'the host has no Shadow root');
    assert.ok(container.shadowRoot.querySelector('[data-fruitback-host-launch]'), 'the launch button leaked out');
    // Nothing of ours in the page's own tree beyond the single empty container.
    assert.equal(page.document.querySelector('.fruitback-launch'), null);
    assert.equal(page.document.querySelector('.fruitback-highlight'), null);
  });

  it('sits at the document origin, so the overlay can position in document coordinates', () => {
    // `createOverlay({ host })` places pins absolutely; an offset or positioned host moves them all.
    const { page } = mount(() => null);
    const container = page.document.querySelector('[data-fruitback-host]') as HTMLElement;

    assert.equal(container.style.position, 'absolute');
    assert.equal(container.style.top, '0px');
    assert.equal(container.style.left, '0px');
    assert.equal(container.style.width, '0px');
  });

  it('does nothing until the floating button is pressed', () => {
    const { page } = mount(() => page.query('#cta'));
    assert.equal(host?.capturing(), false);

    moveOver(page);
    const highlight = host?.root.querySelector('[data-fruitback-host-highlight]') as HTMLElement;
    assert.equal(highlight.style.display, '');

    launchButton().click();
    assert.equal(host?.capturing(), true);
  });

  it('highlights the element under the pointer, in document coordinates', () => {
    const { page } = mount(() => page.query('#cta'));
    host?.start();

    moveOver(page);

    const highlight = host?.root.querySelector('[data-fruitback-host-highlight]') as HTMLElement;
    assert.equal(highlight.style.display, 'block');
    assert.equal(highlight.style.left, '10px');
    assert.equal(highlight.style.top, '20px');
    assert.equal(highlight.style.width, '100px');
  });

  it('refuses to point at its own UI', async () => {
    // react-grab traverses open Shadow roots, so without the filter the pointer lands on our
    // highlight box instead of the element behind it.
    const { page, engine } = mount(() => host?.root.querySelector('[data-fruitback-host-launch]') ?? null);
    host?.start();

    moveOver(page);

    assert.equal(engine.rejected.length, 1, 'the host did not reject its own button');
    const highlight = host?.root.querySelector('[data-fruitback-host-highlight]') as HTMLElement;
    assert.equal(highlight.style.display, 'none');
  });

  it('hands back the element and the source react-grab resolved for it', async () => {
    const selected: CaptureTarget[] = [];
    const { page } = mount(
      () => page.query('#cta'),
      (target) => selected.push(target),
    );
    host?.start();

    clickAt(page, page.query('#cta'));
    await Promise.resolve();
    await Promise.resolve();

    assert.equal(selected.length, 1);
    assert.equal(selected[0]?.element, page.query('#cta'));
    assert.deepEqual(selected[0]?.source, { component: 'CheckoutCta', file: 'src/cta.tsx', line: 12 });
    // One capture per activation: the mode ends with the click.
    assert.equal(host?.capturing(), false);
  });

  it('keeps the page from acting on the click it just intercepted', () => {
    // The reporter is pointing at the site, not using it — a captured click must not submit a form.
    const { page } = mount(() => page.query('#cta'));
    let pageSawIt = false;
    page.query('#cta').addEventListener('click', () => (pageSawIt = true));
    host?.start();

    clickAt(page, page.query('#cta'));

    assert.equal(pageSawIt, false);
  });

  it('lets the page have its clicks back when capture is off', () => {
    const { page } = mount(() => page.query('#cta'));
    let pageSawIt = false;
    page.query('#cta').addEventListener('click', () => (pageSawIt = true));

    clickAt(page, page.query('#cta'));

    assert.equal(pageSawIt, true);
  });

  it('leaves capture mode on Escape', () => {
    const { page } = mount(() => page.query('#cta'));
    host?.start();

    pressKey(page, 'Escape');

    assert.equal(host?.capturing(), false);
  });

  it('takes its host element and its listeners with it when destroyed', () => {
    const { page } = mount(() => page.query('#cta'));
    let pageSawIt = false;
    page.query('#cta').addEventListener('click', () => (pageSawIt = true));
    host?.start();

    host?.destroy();
    host = null;
    clickAt(page, page.query('#cta'));

    assert.equal(page.document.querySelector('[data-fruitback-host]'), null);
    // The listener is gone too, so the page is not left with a widget that swallows clicks.
    assert.equal(pageSawIt, true);
  });
});
