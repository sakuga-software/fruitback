import AxeBuilder from '@axe-core/playwright';
import { type Page, expect } from '@playwright/test';
import { PLAYGROUND_ORIGIN, addRule, mintPairing, openBareSite, openPopup, test, SITE_SWITCH } from './extension.ts';
import { WORKER_ORIGIN } from './pin.ts';
import { AUTHENTICATED_WORKER_ORIGIN } from './worker-sessions.ts';

/** The one `chrome.*` call of these specs, from the service worker: the rules in storage. */
declare const chrome: {
  storage: { local: { get(key: string): Promise<Record<string, unknown>>; set(items: object): Promise<void> } };
};

/**
 * The layout of the popup in its five states (FRU-169): signed out, a pairing link, paired, a site of
 * the workspace, a site turned on.
 *
 * The popup is opened in a tab, like every spec of the extension. Its real window follows its
 * content, which is 380 px wide since the shell of FRU-297, so the tab is measured at 380 px.
 */

/** A name as long as an address: forty characters. */
const NAME = 'qa+popup-layout-reviewer-01@example.test';
const WIDTHS = [380];
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
        // The lines of its words only: the dot of the button of the account is a box, not a line.
        const walker = document.createTreeWalker(button, NodeFilter.SHOW_TEXT);
        const tops = new Set<number>();
        for (let text = walker.nextNode(); text !== null; text = walker.nextNode()) {
          const range = document.createRange();
          range.selectNodeContents(text);
          for (const rect of range.getClientRects()) tops.add(Math.round(rect.top));
        }

        return { name: button.getAttribute('aria-label') ?? button.textContent ?? '', lines: tops.size };
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
        measured.buttons.filter((button) => button.lines > 1),
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
    await expect(empty.getByRole('button', { name: /^(Sign in with email|Se connecter par e-mail)$/ })).toBeVisible();
    expect(await empty.evaluate(() => document.documentElement.lang)).toBe(language);
    // Screen 1 (FRU-297): e-mail, Google, GitHub, and the link of the foot.
    await expectLaidOut(empty, 'signed out', 4);
    await expectNothingCut(empty, 'signed out', language);
    await empty.close();

    // 2. A pairing link.
    const { link } = await mintPairing(NAME);
    const worker = await extension.context.newPage();
    await worker.goto(link);
    const linked = await openPopup(extension, worker, AUTHENTICATED_WORKER_ORIGIN);
    const pair = linked.getByRole('button', { name: /^(Pair with this worker|Se connecter à ce serveur)$/ });
    await expect(pair).toBeVisible();
    // FRU-302: « Pair in the page of the extension » joins the buttons.
    await expectLaidOut(linked, 'pairing link', 4);

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
    const turnOn = offered.getByRole('button', { name: /^(Turn on|Activer)$/ });
    await expect(turnOn).toBeVisible();
    await expectLaidOut(offered, 'site of the workspace', 2);

    // 5. The site turned on (FRU-298): the gear, the switch, « Show Fruitback on this page » (FRU-444),
    // « Leave feedback » and the icon of the side panel beside it (FRU-529); the head names the person of the pairing. The worker of this spec says nothing of
    // the notes of the site, so no line of what waits.
    await turnOn.click();
    await expect(offered.getByRole('switch', { name: SITE_SWITCH })).toBeChecked();
    await expect(offered.getByRole('button', { name: /^(Account and settings|Compte et réglages)$/ })).toHaveText('Q');
    // The row of the pairing stays, with its log out.
    await expect(offered.getByText(/^(Paired as|Connecté en tant que) /)).toBeVisible();
    await expectLaidOut(offered, 'site turned on', 6);

    // The kit (FRU-293), read on computed styles in both schemes: the measures of the mock-up of
    // 2026-10-20, the accent of the extension, and no word cut.
    for (const colorScheme of ['light', 'dark'] as const) {
      await offered.emulateMedia({ colorScheme });
      // Out of every button, and once the switch has its colour: its transition takes 0.2 s, and a
      // fixed wait of 0.4 s read it half-way on CI once.
      await offered.mouse.move(0, 0);
      await expect
        .poll(() =>
          offered
            .locator('.kit-switch')
            .first()
            .evaluate((node) => getComputedStyle(node).backgroundColor),
        )
        .toBe(ACCENT[colorScheme]);
      await expect
        .poll(() => offered.locator('.kit-primary').evaluate((node) => getComputedStyle(node).backgroundColor))
        .toBe(ACCENT[colorScheme]);
      const kit = await readKit(offered);
      const where = `${language}, ${colorScheme}`;
      // « Leave feedback » of screen 3 (FRU-298): the tall button of the kit, 56 px, the corner of 12.
      expect.soft(kit.primary, `${where}: the main button`).toMatchObject({
        height: 56,
        radius: '12px',
        font: '16px 650',
        fill: ACCENT[colorScheme],
      });
      // « Show all notes in a sidebar » (FRU-529): a square of one icon, as high as « Leave feedback ».
      expect.soft(kit.secondary, `${where}: the button of the side panel`).toMatchObject({
        height: 56,
        width: 56,
        radius: '12px',
        font: '14px 600',
        edge: CONTROL_EDGE[colorScheme],
      });
      expect.soft(kit.switch, `${where}: the switch`).toEqual({ width: 44, height: 26, fill: ACCENT[colorScheme] });
      expect.soft(kit.knob, `${where}: the knob`).toEqual({ width: 20, height: 20, right: 3 });
      expect.soft(kit.cut, `${where}: a word cut`).toEqual([]);
    }
    await offered.emulateMedia({ colorScheme: 'light' });

    // A switch is a button: Space and Enter press it.
    const onOff = offered.getByRole('switch', { name: SITE_SWITCH });
    await onOff.focus();
    await offered.keyboard.press('Space');
    await expect(offered.getByRole('switch', { name: SITE_SWITCH })).toHaveAttribute('aria-checked', 'false');
    // The screen of a site that is off is drawn again, with no action: the next key goes to its switch.
    await expect(offered.locator('.kit-primary')).toHaveCount(0);
    await offered.getByRole('switch', { name: SITE_SWITCH }).focus();
    await offered.keyboard.press('Enter');
    await expect(offered.getByRole('switch', { name: SITE_SWITCH })).toHaveAttribute('aria-checked', 'true');
    await expect(offered.locator('.kit-primary')).toHaveCount(1);
  });
}

/** No word of a control cut, and nothing past the 380 px of the popup, in both schemes. */
async function expectNothingCut(popup: Page, state: string, language: string): Promise<void> {
  for (const colorScheme of ['light', 'dark'] as const) {
    await popup.emulateMedia({ colorScheme });
    const read = await popup.evaluate(() => ({
      cut: [...document.querySelectorAll<HTMLElement>('button, h1, .kit-alert-title, .kit-alert-body, .invited')]
        .filter((node) => node.scrollWidth > node.clientWidth + 1)
        .map((node) => node.textContent),
      wide: document.documentElement.scrollWidth,
    }));
    expect.soft(read.cut, `${state}, ${language}, ${colorScheme}: a word cut`).toEqual([]);
    expect.soft(read.wide, `${state}, ${language}, ${colorScheme}: wider than the popup`).toBeLessThanOrEqual(380);
  }
  await popup.emulateMedia({ colorScheme: 'light' });
}

/** The boxes of screen 4 of the mock-up (popup/ExtPopups.dc.html, measured in a browser), ± 2 px. */
const PROBLEM_BOXES = {
  tile: { x: 24, y: 78, width: 40, height: 40 },
  alert: { x: 24, y: 141, width: 332 },
  allow: { x: 24, y: 456, width: 332, height: 46 },
  off: { x: 24, y: 512, width: 332, height: 44 },
} as const;

/**
 * 4 · A problem, with its fix (FRU-297), for real: a rule that is on, for an origin the browser does
 * not grant. The copy of the extension holds access to `localhost` only, so the worker read on
 * `127.0.0.1` is a site whose access is gone. « Allow access again » asks the browser, and automation
 * cannot answer that prompt: the spec turns the site off instead, which keeps the rule.
 */
test.describe('screen 4 (FRU-297)', () => {
  // The click on the toolbar gives the popup the address of the tab (`activeTab`): `tabs` stands for it.
  test.use({ extraPermissions: ['tabs'] });
  for (const language of ['en', 'fr'] as const) {
    test(`screen 4: a site whose access was removed, at 380 px, in both schemes, in ${language}`, async ({
      extension,
    }) => {
      if (language === 'fr') {
        await extension.context.addInitScript(() => {
          Object.defineProperty(navigator, 'language', { get: () => 'fr-FR' });
        });
      }
      const origin = WORKER_ORIGIN.replace('localhost', '127.0.0.1');
      await extension.worker.evaluate(
        async ({ pattern, endpoint }) => {
          await chrome.storage.local.set({
            sites: { [pattern]: { endpoint, enabled: true, mode: 'private', clientId: 'playground' } },
          });
        },
        { pattern: origin, endpoint: WORKER_ORIGIN },
      );
      const site = await extension.context.newPage();
      await site.goto(`${origin}/health`);
      const popup = await openPopup(extension, site);
      await popup.setViewportSize({ width: 380, height: 580 });

      const allow = popup.getByRole('button', { name: /^(Allow access again|Autoriser à nouveau)$/ });
      const off = popup.getByRole('button', { name: /^(Turn off for this site|Désactiver pour ce site)$/ });
      await expect(allow).toBeVisible();
      await expect(popup.getByRole('alert')).toContainText(
        language === 'en' ? "Fruitback can't open this page" : 'Fruitback ne peut pas ouvrir cette page',
      );
      await expect(popup.locator('.kit-site-state')).toHaveText(language === 'en' ? 'Paused' : 'En pause');
      await expect(popup.locator('.kit-site-host')).toHaveText('127.0.0.1:8788');
      await expectLaidOut(popup, 'a problem', 3);
      await expectNothingCut(popup, 'a problem', language);
      // Where the font is the mock-up's: the CI draws Linux's, a pixel or two off (see popup-sign-in).
      if (language === 'en' && process.platform === 'darwin') {
        for (const [name, locator] of [
          ['tile', popup.locator('.kit-tile')],
          ['alert', popup.getByRole('alert')],
          ['allow', allow],
          ['off', off],
        ] as const) {
          const box = await locator.boundingBox();
          for (const [side, value] of Object.entries(PROBLEM_BOXES[name])) {
            expect
              .soft(Math.abs((box?.[side as 'x'] ?? Number.NaN) - value), `${name}: ${side} is ${box?.[side as 'x']}`)
              .toBeLessThanOrEqual(2);
          }
        }
      }

      // « Turn off for this site » keeps the rule, off, and the popup draws the rule again.
      await off.click();
      await expect(allow).toHaveCount(0);
      expect(
        await extension.worker.evaluate(async (pattern) => {
          const { sites } = (await chrome.storage.local.get('sites')) as {
            sites: Record<string, { enabled: boolean }>;
          };

          return sites[pattern]?.enabled;
        }, origin),
      ).toBe(false);
    });
  }
});

/** The accent of the extension in each scheme: the red of the console and of the widget (FRU-372). */
const ACCENT = { light: 'rgb(221, 44, 39)', dark: 'rgb(236, 106, 101)' } as const;
/** The edge of a second button: `--line-control`. */
const CONTROL_EDGE = { light: 'rgb(161, 161, 170)', dark: 'rgb(113, 113, 122)' } as const;
/** The parts of the kit on the screen of a site that is on. */
function readKit(popup: Page) {
  return popup.evaluate(() => {
    const style = (selector: string) => {
      const node = document.querySelector(selector);
      if (node === null) throw new Error(`no ${selector}`);

      return { node, style: getComputedStyle(node), box: node.getBoundingClientRect() };
    };
    const primary = style('.kit-primary');
    const secondary = style('.kit-secondary');
    const toggle = style('.kit-switch');
    const knob = style('.kit-knob');

    return {
      primary: {
        height: primary.box.height,
        radius: primary.style.borderRadius,
        font: `${primary.style.fontSize} ${primary.style.fontWeight}`,
        fill: primary.style.backgroundColor,
      },
      secondary: {
        height: secondary.box.height,
        width: secondary.box.width,
        radius: secondary.style.borderRadius,
        font: `${secondary.style.fontSize} ${secondary.style.fontWeight}`,
        edge: secondary.style.borderTopColor,
      },
      switch: { width: toggle.box.width, height: toggle.box.height, fill: toggle.style.backgroundColor },
      // Checked: the knob sits 3 px from the right end of the track.
      knob: {
        width: knob.box.width,
        height: knob.box.height,
        right: Math.round(toggle.box.right - knob.box.right),
      },
      cut: [...document.querySelectorAll<HTMLElement>('.kit-primary, .kit-secondary')]
        .filter((button) => button.scrollWidth > button.clientWidth)
        .map((button) => button.textContent),
    };
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
  await expect(empty.getByRole('button', { name: 'Sign in with email' })).toBeVisible();
  await clean(empty, 'the popup signed out');
  // One popup at a time: `openPopup` finds the popup by its address.
  await empty.close();

  await addRule(extension, { mode: 'private', clientId: 'playground', endpoint: WORKER_ORIGIN });
  const on = await openPopup(extension, page);
  await expect(on.getByRole('button', { name: 'Turn off here' })).toBeVisible();
  await clean(on, 'the popup with the site on');

  const options = await extension.context.newPage();
  await options.goto(`chrome-extension://${extension.id}/options.html`);
  await expect(options.getByRole('button', { name: 'Add a site' })).toBeVisible();
  await clean(options, 'the options page');
});
