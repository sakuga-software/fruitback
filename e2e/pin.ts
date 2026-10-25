import { expect, type Locator, type Page, test } from '@playwright/test';

/**
 * The worker's dev port, mirrored from `playwright.config.ts` — this suite starts both servers, so
 * it knows the topology. The app itself takes the origin from `VITE_FRUITBACK_WORKER` and has no
 * business exposing a global just so a test can find it.
 */
export const WORKER_ORIGIN = 'http://localhost:8788';

/**
 * The three moves every spec makes: open a page of one's own, plant a pin, and check a pin sits on
 * an element.
 *
 * The harness these drive is the playground's, not the product's — the real capture UI is FRU-3/493
 * and the real re-anchoring is FRU-11. What the specs actually assert through it is the pipeline
 * underneath: `captureNote`, `POST /feedback`, `GET /feedback`.
 */

/**
 * Each spec captures on its own URL. The note's page identity is the canonical URL, so a query
 * parameter is all it takes to keep one spec's pins out of another's — the worker's in-memory store
 * lives for the whole run.
 */
export async function openPlayground(page: Page, testCase: string): Promise<void> {
  // The retry gets a page of its own. The worker's store lives for the whole run, so a spec that
  // failed after planting leaves its pin behind: replaying on the same URL then finds two notes with
  // the same text, and the retry can never pass — it reports an ambiguous locator instead of the
  // thing that actually broke. This is what made a CI flake look like a different bug.
  await page.goto(`/?case=${caseOf(testCase)}`);
  await expect(page.getByRole('heading', { name: 'Nos formules' })).toBeVisible();
  await expect(status(page)).toHaveText(/pin|^0/, { timeout: 15_000 });
}

/**
 * The name of the page of one run of a spec. A retry, and each repetition of `--repeat-each`, gets a
 * page of its own: the worker's store lives for the whole run, so a second run on the same URL finds
 * the pins of the first. With one URL for all, `--repeat-each 20` failed 19 times out of 20 on a pin
 * count (FRU-186), and a flake could not be measured.
 */
export function caseOf(testCase: string): string {
  const { retry, repeatEachIndex } = test.info();

  return [testCase, repeatEachIndex > 0 ? `repeat${repeatEachIndex}` : '', retry > 0 ? `retry${retry}` : '']
    .filter((part) => part !== '')
    .join('-');
}

/** Capture mode, a click on `target`, a note, send — and wait for the pin to come back. */
export async function plantPin(page: Page, target: Locator, note: string): Promise<void> {
  const before = await page.locator('[data-fruitback-pin]').count();
  const plantedBefore = await planted(page).textContent();

  // The launch button lives in the widget's Shadow root, which Playwright's selectors pierce. The
  // name is a pattern rather than a string because an embedder sets the label — it opened with a
  // sprout until FRU-36, and it is a mark beside the words now.
  await page.getByRole('button', { name: /Leave feedback/ }).click();
  await target.click();
  await page.getByPlaceholder('What should change?').fill(note);
  await page.getByRole('button', { name: 'Send', exact: true }).click();

  // Synchronised on the identifier, not on the status line. The status has two writers — this
  // harness and the widget announcing a re-resolution it decided on by itself (FRU-21) — so a
  // confirmation can be overwritten by a pin count arriving a moment later. It was, on CI, where the
  // timing differs. Counting pins alone races too: the old ones are still on the page while the new
  // set is being fetched.
  await expect(planted(page)).not.toHaveText(plantedBefore ?? '');
  await expect(page.locator('[data-fruitback-pin]')).toHaveCount(before + 1);
}

/**
 * Wait until the pins on the page have been drawn again — after a redeploy, a deletion, a reload.
 * Same reason as above: without it, an assertion measures the pins from before the DOM moved.
 */
export async function waitForPins(page: Page, count: number): Promise<void> {
  await expect(status(page)).toHaveText(new RegExp(`^${count} pins?$`));
  await expect(page.locator('[data-fruitback-pin]')).toHaveCount(count);
}

/** Pins are found through their badge, which is the only part of the overlay that carries the note. */
export function pinFor(page: Page, note: string): Locator {
  const badge = page.getByRole('button', { name: new RegExp(escapeForRegExp(note.slice(0, 20))) });

  return page.locator('[data-fruitback-pin]').filter({ has: badge });
}

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function badgeFor(page: Page, note: string): Locator {
  return pinFor(page, note).getByRole('button');
}

/**
 * Sends the note of the open composer, and waits until the playground has planted it.
 *
 * Synchronised on the identifier, never on the status line: the widget writes « 1 pin » there when
 * it re-resolves by itself, and that can land after « planté · … » (FRU-186). Measured under load on
 * `attribution.spec.ts`, 4 runs out of 80 read « 1 pin » for good.
 */
export async function sendNote(page: Page): Promise<void> {
  const before = (await planted(page).textContent()) ?? '';
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(planted(page)).not.toHaveText(before);
}

/** The last identifier planted. Written once per plant, never overwritten. */
export function planted(page: Page): Locator {
  return page.locator('[data-fruitback-dev="planted"]');
}

export function status(page: Page): Locator {
  return page.locator('[data-fruitback-dev="status"]');
}

/** How far the frame of a pin stands off its element: a line of 2 px, 3 px off (FRU-304), as `overlay.ts` has it. */
const FRAME_OUTSET = 5;

/**
 * The assertion that matters: the pin is drawn over the element, not merely present.
 *
 * Polled, because the overlay re-measures on the next animation frame — a resize or a reflow moves
 * the element first and the pin a frame later, and a single measurement would catch the gap. One
 * pixel of tolerance: sub-pixel rounding is expected, being on the neighbouring card is not.
 */
export async function expectPinOn(pin: Locator, element: Locator): Promise<void> {
  await expect
    .poll(
      async () => {
        const [pinBox, elementBox] = await Promise.all([pin.boundingBox(), element.boundingBox()]);
        if (pinBox === null || elementBox === null) return null;

        // The frame stands `FRAME_OUTSET` off the element on every side (FRU-252).
        return Math.max(
          Math.abs(pinBox.x - (elementBox.x - FRAME_OUTSET)),
          Math.abs(pinBox.y - (elementBox.y - FRAME_OUTSET)),
          Math.abs(pinBox.width - (elementBox.width + 2 * FRAME_OUTSET)),
          Math.abs(pinBox.height - (elementBox.height + 2 * FRAME_OUTSET)),
        );
      },
      { message: 'the pin never settled on its element' },
    )
    .toBeLessThanOrEqual(1);
}

/**
 * The notes the worker actually stored for this page, straight from the read path.
 *
 * The URL is rebuilt from `window.location` rather than canonicalized: every spec captures on a
 * plain `/?case=…`, which `canonicalizePageUrl` already leaves untouched. A spec that ever needs a
 * fragment or a tracking parameter has to canonicalize here, or it will look up a key nothing was
 * stored under.
 */
type StoredNote = {
  text: string;
  source?: Record<string, unknown>;
  reporter?: Record<string, unknown>;
  env?: Record<string, unknown>;
};

export async function storedNotes(page: Page): Promise<StoredNote[]> {
  return page.evaluate(async (origin) => {
    const canonical = `${window.location.origin}${window.location.pathname}${window.location.search}`;
    const response = await fetch(`${origin}/feedback?url=${encodeURIComponent(canonical)}&client=playground`);
    const { issues } = (await response.json()) as { issues: { note: StoredNote }[] };

    return issues.map((issue) => issue.note);
  }, WORKER_ORIGIN);
}

/**
 * Waits until React has hydrated the page.
 *
 * The server sends the page whole, so its heading is visible before React runs. Until React
 * hydrates, an element holds no fiber, and a note planted on it has no `source`: no component, no
 * file. That is right for the product, and it failed the spec that reads the component (FRU-186):
 * under load the click came first, about one run in twenty. With the scripts of the page held back
 * three seconds, it fails every time. The sign is the fiber that React puts on the element, read in
 * the world of the page.
 */
export async function hydrated(page: Page): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const button = document.querySelector('[data-testid="card-latte"] .add');

          return button !== null && Object.getOwnPropertyNames(button).some((name) => name.startsWith('__reactFiber$'));
        }),
      { message: 'React never hydrated the page', timeout: 15_000 },
    )
    .toBe(true);
}
