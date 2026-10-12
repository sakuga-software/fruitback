import { type Page, expect } from '@playwright/test';
import { PLAYGROUND_ORIGIN, mintPairing, openBareSite, openPopup, test } from './extension.ts';
import { AUTHENTICATED_WORKER_ORIGIN } from './worker-sessions.ts';

/**
 * The layout of the popup in its five states (FRU-169): no rule, a pairing link, paired, a site of
 * the workspace, a site turned on.
 *
 * The popup is opened in a tab, like every spec of the extension. Its real window follows its
 * content from 280 px, so the tab is measured at 280 and at 340 px.
 */

/** A name as long as an address: forty characters. */
const NAME = 'qa+popup-layout-reviewer-01@example.test';
const WIDTHS = [280, 340];
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

    // 1. No rule: the form.
    const empty = await openPopup(extension, page);
    await expect(empty.getByRole('button', { name: /^(Turn on for this site|Activer pour ce site)$/ })).toBeVisible();
    expect(await empty.evaluate(() => document.documentElement.lang)).toBe(language);
    await expectLaidOut(empty, 'no rule', 2);
    await empty.close();

    // 2. A pairing link.
    const { link } = mintPairing(NAME);
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
    const turnOn = offered.getByRole('button', { name: /^(Turn on Fruitback here|Activer Fruitback ici)$/ });
    await expect(turnOn).toBeVisible();
    await expectLaidOut(offered, 'site of the workspace', 3);

    // 5. The site turned on, and still paired.
    await turnOn.click();
    await expect(offered.getByRole('button', { name: /^(Turn off here|Désactiver ici)$/ })).toBeVisible();
    await expect(offered.getByText(NAME, { exact: false })).toBeVisible();
    await expectLaidOut(offered, 'site turned on', 4);
  });
}
