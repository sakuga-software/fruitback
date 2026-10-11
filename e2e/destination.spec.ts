import AxeBuilder from '@axe-core/playwright';
import { type Page, expect, test } from '@playwright/test';
import { WORKER_ORIGIN } from './pin.ts';

/**
 * Where a note goes (FRU-123), on the widget as `init` assembles it: the line at the foot of the
 * composer, the choice, and what travels to the worker.
 *
 * The playground builds the widget part by part and gives its composer no places, so this spec loads
 * the built script, like `sidebar.spec.ts`.
 *
 * **The places are put in the answer of the read here, not by the worker.** The worker names them
 * only to a member of a workspace, which this suite has none of. So the spec holds the widget's half:
 * what it shows for an answer, and the request it makes. What the worker does with `?destination=`
 * is held by its own tests.
 */
const IIFE = 'packages/widget/dist/fruitback.iife.js';

const WEB = { id: 'dst_web', label: 'Linear · Web' };
const DESIGN = { id: 'dst_design', label: 'Linear · Design' };
/** A place set before the worker wrote labels has none. */
const OLD = { id: 'dst_old' };

type Sent = { query: string; body: Record<string, unknown> };

/**
 * Make the worker answer like it does to a member: the read names `offered()`, and each write is
 * kept for the test to look at. `refuse` answers a write like the worker does for a place the site
 * no longer has. A write that is not refused reaches the worker without its choice.
 */
async function asMember(
  page: Page,
  offered: () => unknown,
  refuse: (query: URLSearchParams) => boolean = () => false,
): Promise<Sent[]> {
  const sent: Sent[] = [];
  await page.route(
    (url) => url.origin === WORKER_ORIGIN && url.pathname === '/feedback',
    async (route) => {
      const request = route.request();
      if (request.method() === 'GET') {
        const response = await route.fetch();

        return route.fulfill({ response, json: { ...(await response.json()), destinations: offered() } });
      }
      if (request.method() !== 'POST') return route.fallback();

      const url = new URL(request.url());
      sent.push({ query: url.search, body: request.postDataJSON() as Record<string, unknown> });
      if (refuse(url.searchParams)) {
        return route.fulfill({
          status: 403,
          contentType: 'application/json',
          headers: { 'Access-Control-Allow-Origin': '*' },
          body: '{"error":"destination-not-allowed"}',
        });
      }

      // The real worker knows `?destination=` and has no such place: it would refuse the note. The
      // place exists only in this answer, so the note goes on as one that names no place.
      return url.search === '' ? route.fallback() : route.continue({ url: `${url.origin}${url.pathname}` });
    },
  );

  return sent;
}

async function mount(page: Page, testCase: string): Promise<void> {
  const attempt = test.info().retry;
  await page.goto(`/?widget=off&case=${attempt === 0 ? testCase : `${testCase}-retry${attempt}`}`);
  await page.getByRole('heading', { name: 'Nos formules' }).waitFor();
  await page.addScriptTag({ path: IIFE });
  const read = page.waitForResponse((response) => response.url().startsWith(`${WORKER_ORIGIN}/feedback?url=`));
  await page.evaluate(
    (endpoint) =>
      (globalThis as { Fruitback: { init(options: Record<string, string>): unknown } }).Fruitback.init({
        endpoint,
        clientId: 'playground',
        locale: 'en-US',
      }),
    WORKER_ORIGIN,
  );
  // The line is drawn from the first read, so a composer opened before it proves nothing.
  await read;
}

async function compose(page: Page, card: string): Promise<void> {
  await page.getByRole('button', { name: 'Leave feedback' }).click();
  await page.locator(`[data-testid="${card}"] .add`).click();
  await expect(page.getByPlaceholder('What is wrong here?')).toBeFocused();
}

async function send(page: Page, note: string): Promise<void> {
  await page.getByPlaceholder('What is wrong here?').fill(note);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
}

const composer = (page: Page) => page.getByRole('dialog', { name: 'Leave a note' });
const line = (page: Page) => composer(page).getByRole('button', { name: /^Send to: / });
const places = (page: Page) => composer(page).getByRole('radiogroup', { name: 'Where this note goes' });

async function landed(page: Page, note: string): Promise<void> {
  await expect(page.getByRole('button', { name: new RegExp(note) }).first()).toBeVisible();
  // The popover stays open in its sent state for a moment.
  await expect(composer(page)).toBeHidden({ timeout: 5_000 });
}

test('a reader the worker offers no place gets the composer with no line, and a member gets one', async ({ page }) => {
  // The popover grows as it comes in, and a height read then is the height of a moment.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  // The control: this worker names no place, like every worker to a visitor, a guest and a client.
  await mount(page, 'destination-none');
  await compose(page, 'card-espresso');
  await expect(composer(page).locator('[data-fruitback-destination]')).toBeHidden();
  await expect(composer(page).getByRole('radio')).toHaveCount(0);
  // The place of the notice is always in the tree, for a screen reader. Empty, it takes no room.
  expect((await composer(page).locator('[data-fruitback-destination-gone]').boundingBox())?.height).toBe(0);
  const plain = await composer(page).boundingBox();
  await page.keyboard.press('Escape');

  // One place is no choice either.
  let offered: unknown = [WEB];
  await asMember(page, () => offered);
  await mount(page, 'destination-none');
  await compose(page, 'card-espresso');
  await expect(composer(page).locator('[data-fruitback-destination]')).toBeHidden();
  expect((await composer(page).boundingBox())?.height).toBe(plain?.height);
  await page.keyboard.press('Escape');

  // Two places: the line is there, folded, on the first one.
  offered = [WEB, DESIGN];
  await mount(page, 'destination-none');
  await compose(page, 'card-espresso');
  await expect(line(page)).toHaveText('Send to: Linear · Web');
  await expect(line(page)).toHaveAttribute('aria-expanded', 'false');
  await expect(places(page)).toBeHidden();
  // One line of small text more than the composer of everybody else, and nothing else.
  const withLine = (await composer(page).boundingBox())?.height ?? 0;
  expect(withLine - (plain?.height ?? 0)).toBeGreaterThan(10);
  expect(withLine - (plain?.height ?? 0)).toBeLessThan(40);
});

test('a member chooses a place with the keyboard, the note goes there, and the next note starts there', async ({
  page,
}) => {
  const sent = await asMember(page, () => [WEB, DESIGN, OLD]);
  await mount(page, 'destination-choose');
  await compose(page, 'card-espresso');

  // From the note: the name disclosure, then the line. Enter unfolds it onto the place that is chosen.
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  await expect(line(page)).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(places(page)).toBeVisible();
  await expect(places(page).getByRole('radio')).toHaveCount(3);
  await expect(places(page).getByRole('radio', { name: 'Linear · Web' })).toBeFocused();
  await expect(places(page).getByRole('radio', { name: 'Linear · Web' })).toBeChecked();
  await expect(places(page).getByRole('radio', { name: 'Destination 3' })).toBeVisible();

  // The arrows belong to the radios here, and not to the capture mode that opened this popover.
  await page.keyboard.press('ArrowDown');
  await expect(places(page).getByRole('radio', { name: 'Linear · Design' })).toBeChecked();
  await expect(line(page)).toHaveText('Send to: Linear · Design');

  await send(page, 'A note for the design team');
  await landed(page, 'A note for the design team');
  expect(sent.map((each) => each.query)).toEqual(['?destination=dst_design']);
  // The body is the seed, and the choice is not in it.
  expect(sent[0]?.body.note).toBe('A note for the design team');
  expect(JSON.stringify(sent[0]?.body)).not.toContain('dst_design');
  expect(Object.keys(sent[0]?.body ?? {})).not.toContain('destination');

  // Another page load: the choice was kept for this site, and the line is folded on it.
  await mount(page, 'destination-choose');
  await compose(page, 'card-mocha');
  await expect(line(page)).toHaveText('Send to: Linear · Design');
  await expect(places(page)).toBeHidden();

  // Back on the first place, the request is the one of a reader who has no choice.
  await line(page).click();
  await places(page).getByRole('radio', { name: 'Linear · Web' }).check();
  await expect(line(page)).toHaveText('Send to: Linear · Web');
  await send(page, 'A note for the default place');
  await landed(page, 'A note for the default place');
  expect(sent.map((each) => each.query)).toEqual(['?destination=dst_design', '']);
});

test('a place the worker refuses keeps the note, and the line says where the note goes now', async ({ page }) => {
  // An admin takes Design off the list while the popover is open: the write is refused, and the
  // read after it no longer names the place.
  let offered = [WEB, DESIGN, OLD];
  const sent = await asMember(
    page,
    () => offered,
    (query) => {
      if (query.get('destination') !== DESIGN.id) return false;
      offered = [WEB, OLD];

      return true;
    },
  );
  await mount(page, 'destination-refused');
  await compose(page, 'card-latte');
  await line(page).click();
  await places(page).getByRole('radio', { name: 'Linear · Design' }).check();

  const note = 'A note that took time to write';
  await send(page, note);

  await expect(composer(page)).toContainText(/did not go through/);
  await expect(page.getByPlaceholder('What is wrong here?')).toHaveValue(note);
  await expect(composer(page)).toContainText('Sending to Linear · Design is no longer possible.');
  await expect(line(page)).toHaveText('Send to: Linear · Web');
  await expect(places(page).getByRole('radio')).toHaveCount(2);
  await expect(page.getByRole('button', { name: new RegExp(note) })).toHaveCount(0);

  // One more click, and the note goes where the line says.
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await landed(page, note);
  expect(sent.map((each) => each.query)).toEqual(['?destination=dst_design', '']);
});

test('a long name of a place stays inside the popover, and inside the sheet of a phone', async ({ page }) => {
  const long = { id: 'dst_long', label: `Linear · ${'Internationalisation'.repeat(4)} · ${'x'.repeat(60)}` };
  await asMember(page, () => [long, DESIGN]);

  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    await mount(page, `destination-long-${viewport.width}`);
    await compose(page, 'card-espresso');
    await line(page).click();
    await expect(places(page)).toBeVisible();

    const box = await composer(page).evaluate((node) => {
      const own = node.getBoundingClientRect();
      const inner = [...node.querySelectorAll('[data-fruitback-destination], [data-fruitback-destinations] label')];

      return {
        left: own.left,
        right: own.right,
        overflows: node.scrollWidth > node.clientWidth,
        widest: Math.max(...inner.map((each) => each.getBoundingClientRect().right)),
      };
    });
    expect(box.overflows, `at ${viewport.width}px`).toBe(false);
    expect(box.widest, `at ${viewport.width}px`).toBeLessThanOrEqual(box.right);
    expect(box.left).toBeGreaterThanOrEqual(0);
    expect(box.right).toBeLessThanOrEqual(viewport.width);
    await page.keyboard.press('Escape');
  }
});

for (const scheme of ['light', 'dark'] as const) {
  test(`axe-core finds nothing in the choice of a place, in the ${scheme} scheme`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    let offered = [WEB, DESIGN, OLD];
    await asMember(page, () => offered);
    await mount(page, `destination-axe-${scheme}`);
    await compose(page, 'card-latte');
    await line(page).click();
    await places(page).getByRole('radio', { name: 'Linear · Design' }).check();
    // The notice too: a read under the open popover takes the chosen place away.
    offered = [WEB, OLD];
    // The widget reads again when the address changes, which is the read a test can ask for.
    await page.evaluate(() => history.replaceState(null, '', `${location.href}&again=1`));
    await expect(composer(page)).toContainText('Sending to Linear · Design is no longer possible.');
    await expect(places(page)).toBeVisible();

    const scan = async (): Promise<string[]> => {
      const results = await new AxeBuilder({ page }).include('[data-fruitback-host]').analyze();

      return results.violations.flatMap((violation) =>
        violation.nodes.map((node) => `${violation.id} on ${node.target.join(' ')}`),
      );
    };

    expect(await scan()).toEqual([]);

    // The control for the empty list: names as pale as the popover must be a finding.
    await page.locator('[data-fruitback-host]').evaluate((host) => {
      (host as HTMLElement).style.setProperty('--fruitback-color-text-muted', '#bbb');
      (host as HTMLElement).style.setProperty('--fruitback-color-surface-raised', '#ccc');
    });
    expect((await scan()).filter((found) => found.startsWith('color-contrast'))).not.toEqual([]);
  });
}
