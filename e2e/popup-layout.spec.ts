import AxeBuilder from '@axe-core/playwright';
import { type Page, expect } from '@playwright/test';
import { PLAYGROUND_ORIGIN, addRule, mintPairing, openBareSite, openPopup, test } from './extension.ts';
import { WORKER_ORIGIN } from './pin.ts';
import { AUTHENTICATED_WORKER_ORIGIN } from './worker-sessions.ts';

/**
 * The layout of the popup in its five states (FRU-169): signed out, a pairing link, paired, a site of
 * the workspace, a site turned on.
 *
 * The popup is opened in a tab, like every spec of the extension. Its real window follows its
 * content, which is 360 px wide since the shell of FRU-251, so the tab is measured at 360 px.
 */

/** A name as long as an address: forty characters. */
const NAME = 'qa+popup-layout-reviewer-01@example.test';
const WIDTHS = [360];
/** Two buttons that touch read as one control. */
const SPACE = 8;

type Measure = { buttons: { name: string; lines: number }[]; closest: number; past: number };

/** Every visible button of the popup: the lines it takes, and the smallest space between two of them. */
function measure(popup: Page): Promise<Measure> {
  return popup.evaluate(() => {
    const visible = [...document.querySelectorAll('button')].filter((button) => button.getClientRects().length > 0);
    const boxes = visible.map((button) => button.getBoundingClientRect());
    const body = document.body.getBoundingClientRect();
    const inner = body.right - Number.parseFloat(getComputedStyle(document.body).paddingRight);
    let closest = Number.POSITIVE_INFINITY;
    for (const [index, one] of boxes.entries()) {
      for (const other of boxes.slice(index + 1)) {
        const across = Math.max(one.left - other.right, other.left - one.right);
        const down = Math.max(one.top - other.bottom, other.top - one.bottom);
        closest = Math.min(closest, Math.max(across, down));
      }
    }

    return {
      buttons: visible.map((button) => {
        const range = document.createRange();
        range.selectNodeContents(button);

        return {
          name: button.textContent ?? '',
          lines: new Set([...range.getClientRects()].map((rect) => Math.round(rect.top))).size,
        };
      }),
      closest,
      // The body is at least 280 px wide plus its padding, so a tab of 280 px always scrolls. What
      // counts is that no button leaves the box the body gives its content.
      past: Math.max(...boxes.map((box) => box.right)) - inner,
    };
  });
}

async function expectLaidOut(popup: Page, state: string, buttons: number): Promise<void> {
  for (const width of WIDTHS) {
    await popup.setViewportSize({ width, height: 600 });
    const measured = await measure(popup);
    const where = `${state}, ${width} px`;
    // The count is the control: a state that drew no button would pass every check below.
    expect.soft(measured.buttons.length, `${where}: buttons`).toBe(buttons);
    expect
      .soft(
        measured.buttons.filter((button) => button.lines !== 1),
        `${where}: buttons on two lines`,
      )
      .toEqual([]);
    expect.soft(measured.closest, `${where}: the two closest buttons`).toBeGreaterThanOrEqual(SPACE);
    expect.soft(measured.past, `${where}: a button leaves the popup`).toBeLessThanOrEqual(0.5);
  }
}

for (const language of ['en', 'fr'] as const) {
  test(`the popup keeps its buttons apart and on one line, in its five states, in ${language}`, async ({
    extension,
  }) => {
    // The browser of the fixture speaks English. A popup with no account reads the language of the
    // browser, and one with an account reads the account's: both are given here.
    if (language === 'fr') {
      await extension.context.addInitScript(() => {
        Object.defineProperty(navigator, 'language', { get: () => 'fr-FR' });
      });
    }
    // The E2E workers keep no accounts, so the answer of that one route is given here.
    const sites: { id: string; origin: string; visibility: string }[] = [];
    await extension.context.route(`${AUTHENTICATED_WORKER_ORIGIN}/session/sites`, (route) =>
      route.fulfill({ json: { workspace: { id: 'ws_1', name: 'Acme' }, sites, locale: language } }),
    );
    const page = await extension.context.newPage();
    await openBareSite(page, `popup-layout-${language}`);

    // 1. Nothing held: sign in (FRU-251). The gear, the sign-in, and the way to a self-hosted instance.
    const empty = await openPopup(extension, page);
    await expect(
      empty.getByRole('button', { name: /^(Sign in to Fruitback|Se connecter à Fruitback)$/ }),
    ).toBeVisible();
    expect(await empty.evaluate(() => document.documentElement.lang)).toBe(language);
    await expectLaidOut(empty, 'signed out', 3);
    await empty.close();

    // 2. A pairing link.
    const { link } = await mintPairing(NAME);
    const worker = await extension.context.newPage();
    await worker.goto(link);
    const linked = await openPopup(extension, worker, AUTHENTICATED_WORKER_ORIGIN);
    const pair = linked.getByRole('button', { name: /^(Pair with this worker|Appairer avec ce worker)$/ });
    await expect(pair).toBeVisible();
    await expectLaidOut(linked, 'pairing link', 3);

    // 3. Paired, with a name of forty characters beside « Log out ».
    await pair.click();
    await expect(linked.getByText(NAME, { exact: false })).toBeVisible();
    await expect(linked.getByRole('button', { name: /^(Log out|Se déconnecter)$/ })).toBeVisible();
    await expectLaidOut(linked, 'paired', 3);
    await linked.close();
    await worker.close();

    // 4. A site of the workspace: one click turns it on.
    sites.push({ id: 'site_1', origin: PLAYGROUND_ORIGIN, visibility: 'members' });
    const offered = await openPopup(extension, page);
    const turnOn = offered.getByRole('button', { name: /^(Turn on here|Activer ici)$/ });
    await expect(turnOn).toBeVisible();
    await expectLaidOut(offered, 'site of the workspace', 2);

    // 5. The site turned on (FRU-254): the gear, the switch and the two actions; the head names the
    // person of the pairing.
    await turnOn.click();
    await expect(offered.getByRole('switch')).toBeChecked();
    await expect(offered.getByRole('img', { name: new RegExp(NAME.replace(/[.+]/g, '\\$&')) })).toBeVisible();
    // The row of the pairing stays, with its log out.
    await expect(offered.getByText(/^(Paired as|Appairé en tant que) /)).toBeVisible();
    await expectLaidOut(offered, 'site turned on', 5);
  });
}

/**
 * axe-core on the popup and on the options page, in the light scheme and in the dark scheme
 * (FRU-170). Before it no spec ran axe on a page of the extension: `design-tokens.test.ts` measures
 * the tokens, and this measures what a browser paints with them.
 */
test('axe finds nothing on the popup and on the options page, in both schemes', async ({ extension }) => {
  const clean = async (surface: Page, name: string): Promise<void> => {
    for (const colorScheme of ['light', 'dark'] as const) {
      await surface.emulateMedia({ colorScheme });
      const { violations, passes } = await new AxeBuilder({ page: surface }).analyze();

      // A control: axe did measure a contrast on this page, so an empty list is a result.
      expect(
        passes.map((rule) => rule.id),
        `${name}, ${colorScheme}`,
      ).toContain('color-contrast');
      expect(
        violations.map((violation) => `${violation.id}: ${violation.nodes.map((node) => node.target).join(', ')}`),
        `${name}, ${colorScheme}`,
      ).toEqual([]);
    }
  };
  const page = await extension.context.newPage();
  await openBareSite(page, 'popup-axe');

  const empty = await openPopup(extension, page);
  await expect(empty.getByRole('button', { name: 'Sign in to Fruitback' })).toBeVisible();
  await clean(empty, 'the popup signed out');
  // One popup at a time: `openPopup` finds the popup by its address.
  await empty.close();

  await addRule(extension, { mode: 'private', clientId: 'playground', endpoint: WORKER_ORIGIN });
  const on = await openPopup(extension, page);
  await expect(on.getByRole('button', { name: 'Turn off here' })).toBeVisible();
  await clean(on, 'the popup with the site on');

  const options = await extension.context.newPage();
  await options.goto(`chrome-extension://${extension.id}/options.html`);
  await expect(options.getByRole('button', { name: 'Add rule' })).toBeVisible();
  await clean(options, 'the options page');
});
