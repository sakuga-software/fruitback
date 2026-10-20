import AxeBuilder from '@axe-core/playwright';
import fs from 'node:fs/promises';
import { type Page, expect } from '@playwright/test';
import { PLAYGROUND_ORIGIN, addRule, test } from './extension.ts';
import { WORKER_ORIGIN } from './pin.ts';

/**
 * The page of the extension (FRU-301): the menu, and « Sites » as a table with the panel of a rule.
 * What a rule does is the options page's of before (FRU-43 and after): this plays it on the new page,
 * and measures the page against the mock-up of 2026-10-20 (`05_*` of the boards).
 */

/** The one `chrome.*` call of this spec, from the service worker: the rules in storage. */
declare const chrome: {
  storage: { local: { get(key: string): Promise<Record<string, unknown>>; set(items: object): Promise<void> } };
};

/** A rule nobody granted: the copy of the extension holds access to the local origins only. */
const FAR = 'https://staging.elsewhere.example';

async function openPage(page: Page, id: string): Promise<void> {
  await page.goto(`chrome-extension://${id}/options.html`);
  await expect(page.getByRole('heading', { level: 1, name: /^Sites$/ })).toBeVisible();
}

function rowOf(page: Page, pattern: string) {
  return page.locator(`tr.rule-row[data-pattern="${pattern}"]`);
}

async function storedSites(extension: { worker: { evaluate: <T>(fn: () => Promise<T>) => Promise<T> } }) {
  return extension.worker.evaluate(
    async () =>
      (await chrome.storage.local.get('sites')).sites as Record<string, { enabled: boolean; endpoint: string }>,
  );
}

test('the table lists the rules, filters them, opens one in its panel, switches, saves and removes', async ({
  extension,
}) => {
  await addRule(extension, { mode: 'private', clientId: 'playground', endpoint: WORKER_ORIGIN });
  await extension.worker.evaluate(
    async ({ far }) => {
      const { sites } = (await chrome.storage.local.get('sites')) as { sites: Record<string, unknown> };
      await chrome.storage.local.set({
        sites: { ...sites, [far]: { mode: 'team', endpoint: 'https://worker.elsewhere.example', enabled: true } },
      });
    },
    { far: FAR },
  );
  const page = await extension.context.newPage();
  await openPage(page, extension.id);

  // Two rules, sorted, each with its mode, worker and access.
  await expect(page.locator('tr.rule-row')).toHaveCount(2);
  await expect(rowOf(page, PLAYGROUND_ORIGIN)).toContainText('Private');
  await expect(rowOf(page, PLAYGROUND_ORIGIN)).toContainText('localhost:8788');
  await expect(rowOf(page, PLAYGROUND_ORIGIN)).toContainText('Granted');
  await expect(rowOf(page, FAR)).toContainText('Team');
  await expect(rowOf(page, FAR)).toContainText('No access');

  // The filter reads the pattern and the worker.
  const filter = page.getByRole('searchbox', { name: 'Filter sites' });
  await filter.fill('elsewhere');
  await expect(page.locator('tr.rule-row')).toHaveCount(1);
  await filter.fill('nothing like it');
  await expect(page.getByText('No rule matches this filter.')).toBeVisible();
  await filter.fill('');
  await expect(page.locator('tr.rule-row')).toHaveCount(2);

  // From the keyboard: the site of a row is a button, and Enter opens its panel.
  await rowOf(page, FAR).getByRole('button').first().focus();
  await page.keyboard.press('Enter');
  const details = page.getByRole('complementary', { name: 'Site details' });
  await expect(details).toContainText(FAR);
  await expect(rowOf(page, FAR)).toHaveAttribute('aria-selected', 'true');
  await expect(details.getByRole('tab', { name: 'Team' })).toHaveAttribute('aria-selected', 'true');
  await expect(details).toContainText('No access in this browser');
  await expect(details.getByRole('button', { name: 'Grant access' })).toBeVisible();
  // Team mode has no client id.
  await expect(details.getByLabel('Client id')).toBeHidden();

  // The panel of the playground: its worker, its client id, and the grant it holds.
  await rowOf(page, PLAYGROUND_ORIGIN).getByRole('button').first().click();
  await expect(details).toContainText('Access granted');
  await expect(details.getByLabel('Worker endpoint')).toHaveValue(WORKER_ORIGIN);
  await expect(details.getByLabel('Client id')).toHaveValue('playground');

  // « Save » changes the worker; the rule stays on.
  await details.getByLabel('Worker endpoint').fill('http://localhost:8790');
  await details.getByRole('button', { name: 'Save' }).click();
  await expect(rowOf(page, PLAYGROUND_ORIGIN)).toContainText('localhost:8790');
  expect((await storedSites(extension))[PLAYGROUND_ORIGIN]).toMatchObject({
    endpoint: 'http://localhost:8790',
    enabled: true,
  });

  // The switch of the row turns it off, then on: the grant is held, so no prompt.
  const toggle = rowOf(page, PLAYGROUND_ORIGIN).getByRole('switch', { name: `Fruitback on ${PLAYGROUND_ORIGIN}` });
  await toggle.click();
  await expect.poll(async () => (await storedSites(extension))[PLAYGROUND_ORIGIN]?.enabled).toBe(false);
  await rowOf(page, PLAYGROUND_ORIGIN).getByRole('switch').click();
  await expect.poll(async () => (await storedSites(extension))[PLAYGROUND_ORIGIN]?.enabled).toBe(true);
  // From the keyboard: Space presses it, and the focus stays on it when the table is drawn again
  // (raised in review).
  await rowOf(page, PLAYGROUND_ORIGIN).getByRole('switch').focus();
  await page.keyboard.press('Space');
  await expect(rowOf(page, PLAYGROUND_ORIGIN).getByRole('switch')).toHaveAttribute('aria-checked', 'false');
  await expect.poll(async () => (await storedSites(extension))[PLAYGROUND_ORIGIN]?.enabled).toBe(false);
  await expect(rowOf(page, PLAYGROUND_ORIGIN).getByRole('switch')).toBeFocused();
  await page.keyboard.press('Space');
  await expect.poll(async () => (await storedSites(extension))[PLAYGROUND_ORIGIN]?.enabled).toBe(true);
  await expect(rowOf(page, PLAYGROUND_ORIGIN).getByRole('switch')).toBeFocused();

  // « Add a site »: once stored, the panel of the new rule takes the place of the form (raised in review).
  await page.getByRole('button', { name: 'Add a site' }).click();
  await page.getByLabel('Sites', { exact: true }).fill(WORKER_ORIGIN);
  await page.getByLabel('Worker endpoint', { exact: true }).fill(WORKER_ORIGIN);
  await page.getByLabel('Client id', { exact: true }).fill('worker-page');
  await page.getByRole('button', { name: 'Add rule' }).click();
  await expect(details).toContainText(WORKER_ORIGIN);
  await expect(details.getByLabel('Client id')).toHaveValue('worker-page');
  await expect(rowOf(page, WORKER_ORIGIN)).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('button', { name: 'Add rule' })).toHaveCount(0);

  // The switch of the table, with the panel open: its state follows, and what is typed stays (raised in review).
  await rowOf(page, FAR).getByRole('button').first().click();
  await expect(details).toContainText('No access in this browser');
  await details.getByLabel('Worker endpoint').fill('https://typed.elsewhere.example');
  await rowOf(page, FAR).getByRole('switch').click();
  await expect(details).toContainText('No access while it is off');
  await expect(details.getByLabel('Worker endpoint')).toHaveValue('https://typed.elsewhere.example');

  // « Remove rule » removes it, and its panel goes.
  await details.getByRole('button', { name: 'Remove rule' }).click();
  await expect(rowOf(page, FAR)).toHaveCount(0);
  expect(Object.keys(await storedSites(extension)).sort()).toEqual([PLAYGROUND_ORIGIN, WORKER_ORIGIN]);
});

/** The boxes of the mock-up at 1440 px (`05_*`, measured in a browser), ± 2 px. */
const BOXES = {
  menu: { x: 0, width: 260 },
  title: { x: 292, y: 28 },
  filter: { x: 1088, y: 63.8, width: 220, height: 36 },
  add: { x: 1316, y: 63.8, height: 36 },
  table: { x: 292, y: 115.8 },
  panel: { x: 1105.8, y: 115.8, width: 302.2 },
} as const;

for (const language of ['en', 'fr'] as const) {
  test(`the page at 1440 and 900 px, in both schemes, in ${language}: the boxes of the mock-up, axe, nothing cut`, async ({
    extension,
  }) => {
    // The rule first: `addRule` reads the English labels of the page.
    await addRule(extension, { mode: 'private', clientId: 'playground', endpoint: WORKER_ORIGIN });
    if (language === 'fr') {
      await extension.context.addInitScript(() => {
        Object.defineProperty(navigator, 'language', { get: () => 'fr-FR' });
      });
    }
    const page = await extension.context.newPage();
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`chrome-extension://${extension.id}/options.html`);
    const details = page.locator('aside.rule-panel');
    // The first rule is open, as the mock-up shows it.
    await expect(details).toBeVisible();
    // The title of the page has no drop before it, as the mock-up draws it.
    expect(
      await page.getByRole('heading', { level: 1 }).evaluate((title) => getComputedStyle(title, '::before').content),
    ).toBe('none');

    const boxes = {
      menu: page.locator('nav.page-menu'),
      title: page.getByRole('heading', { level: 1 }),
      filter: page.getByRole('searchbox'),
      add: page.locator('.sites-tools button'),
      table: page.locator('.sites-table'),
      panel: details,
    };
    // Where the font is the mock-up's: the CI draws Linux's, a pixel or two off (see popup-sign-in).
    if (language === 'en' && process.platform === 'darwin') {
      for (const [name, locator] of Object.entries(boxes)) {
        const box = await locator.boundingBox();
        for (const [side, value] of Object.entries(BOXES[name as keyof typeof BOXES])) {
          expect
            .soft(Math.abs((box?.[side as 'x'] ?? Number.NaN) - value), `${name}: ${side} is ${box?.[side as 'x']}`)
            .toBeLessThanOrEqual(2);
        }
      }
    }

    for (const width of [1440, 900]) {
      await page.setViewportSize({ width, height: 900 });
      for (const colorScheme of ['light', 'dark'] as const) {
        await page.emulateMedia({ colorScheme });
        const where = `${language}, ${width} px, ${colorScheme}`;
        const read = await page.evaluate(() => ({
          cut: [...document.querySelectorAll<HTMLElement>('button, h1, th, .page-entry')]
            .filter((node) => node.getClientRects().length > 0 && node.scrollWidth > node.clientWidth + 1)
            .map((node) => node.textContent),
          wide: document.documentElement.scrollWidth,
        }));
        expect.soft(read.cut, `${where}: a word cut`).toEqual([]);
        expect.soft(read.wide, `${where}: wider than the window`).toBeLessThanOrEqual(width);
        const { violations } = await new AxeBuilder({ page }).analyze();
        expect
          .soft(
            violations.map((violation) => `${violation.id}: ${violation.nodes.map((node) => node.target).join(', ')}`),
            where,
          )
          .toEqual([]);
      }
    }
    // At 900 px the panel goes under the table; the menu keeps its column.
    const table = await boxes.table.boundingBox();
    const panel = await details.boundingBox();
    expect((panel?.y ?? 0) >= (table?.y ?? 0) + (table?.height ?? 0)).toBe(true);
  });
}

/** A rules file, as « Download » writes it: one private rule nobody in this browser granted. */
function rulesFile(pattern: string): string {
  return JSON.stringify({
    format: 'fruitback-sites',
    version: 1,
    sites: {
      [pattern]: { mode: 'private', endpoint: 'https://feedback.sakuga.dev', clientId: 'legacy', enabled: true },
    },
  });
}

test('« Share rules » downloads the rules, imports a file chosen or dropped, and says why it refuses one (FRU-290)', async ({
  extension,
}) => {
  await addRule(extension, { mode: 'private', clientId: 'playground', endpoint: WORKER_ORIGIN });
  const page = await extension.context.newPage();
  await openPage(page, extension.id);
  const share = page.locator('section#share');
  const result = share.getByRole('status');

  // Export: the count of the table, and the file of the mock-up.
  await expect(share.getByRole('heading', { level: 2, name: 'Share rules' })).toBeVisible();
  await expect(share.locator('.share-export')).toContainText('1 rule · fruitback-rules.json');
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    share.getByRole('button', { name: 'Download' }).click(),
  ]);
  expect(download.suggestedFilename()).toBe('fruitback-rules.json');
  const written = JSON.parse(await fs.readFile(await download.path(), 'utf8')) as { sites: Record<string, unknown> };
  expect(Object.keys(written.sites)).toEqual([PLAYGROUND_ORIGIN]);

  // No native « Choose file » on the page: the input is out of sight, and still named and focusable.
  const input = share.getByLabel('Import a rules file');
  await expect(input).toHaveAttribute('type', 'file');
  const drawn = await input.evaluate((node) => node.getBoundingClientRect().width);
  expect(drawn).toBeLessThanOrEqual(1);
  // From the keyboard: Tab after « Download » reaches it, and the card shows the ring.
  await share.getByRole('button', { name: 'Download' }).focus();
  await page.keyboard.press('Tab');
  await expect(input).toBeFocused();
  const ring = await share.locator('.share-import').evaluate((node) => getComputedStyle(node).outlineStyle);
  expect(ring).toBe('solid');

  // Chosen: the rule lands in the table, said « imported », with no access until it is granted.
  await input.setInputFiles({
    name: 'fruitback-rules.json',
    mimeType: 'application/json',
    buffer: Buffer.from(rulesFile(FAR)),
  });
  await expect(result).toHaveText('Imported 1 rule.');
  await expect(rowOf(page, FAR)).toContainText('This origin · imported');
  await expect(rowOf(page, FAR)).toContainText('No access');
  await expect(share.locator('.share-export')).toContainText('2 rules · fruitback-rules.json');
  await rowOf(page, FAR).getByRole('button').first().click();
  const details = page.getByRole('complementary', { name: 'Site details' });
  await expect(details).toContainText('This rule came from a rules file, and access does not travel with it.');
  await expect(details.getByRole('button', { name: 'Grant access' })).toBeVisible();

  // Dropped: the same, from a file put on the card. An older name is read the same way.
  const other = 'https://beta.legacy-shop.example';
  const transfer = await page.evaluateHandle(
    ({ text }) => {
      const data = new DataTransfer();
      data.items.add(new File([text], 'fruitback-sites.json', { type: 'application/json' }));

      return data;
    },
    { text: rulesFile(other) },
  );
  const card = share.locator('.share-import');
  await card.dispatchEvent('dragenter', { dataTransfer: transfer });
  await card.dispatchEvent('dragover', { dataTransfer: transfer });
  await expect(card).toHaveClass(/dragging/);
  await card.dispatchEvent('drop', { dataTransfer: transfer });
  await expect(result).toHaveText('Imported 1 rule.');
  await expect(rowOf(page, other)).toContainText('imported');
  await expect(card).not.toHaveClass(/dragging/);
  const stored = await storedSites(extension);
  expect(Object.keys(stored).sort()).toEqual([other, PLAYGROUND_ORIGIN, FAR].sort());

  // Refused: a file that is not JSON, and one that is JSON of something else. Nothing is stored.
  await input.setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('not json') });
  await expect(result).toHaveText('That file is not JSON.');
  await input.setInputFiles({
    name: 'package.json',
    mimeType: 'application/json',
    buffer: Buffer.from('{"name":"x"}'),
  });
  await expect(result).toHaveText('That file is not a Fruitback rules file.');
  expect(Object.keys(await storedSites(extension)).length).toBe(3);

  // The two cards, as the mock-up draws them, in both schemes, with no violation.
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme });
    const look = await page.evaluate(() => {
      const style = (selector: string) => getComputedStyle(document.querySelector(selector) as Element);
      const box = (selector: string) => (document.querySelector(selector) as Element).getBoundingClientRect();

      return {
        // The 1.5 px of the mock-up: Chrome draws 1 px at a density of 1, so only the dash is read.
        importBorder: style('.share-import').borderTopStyle,
        radius: style('.share-export').borderTopLeftRadius,
        padding: style('.share-export').paddingTop,
        button: box('.share-export button').height,
        choose: box('.share-choose').height,
        gap: box('.share-import').left - box('.share-export').right,
      };
    });
    expect.soft(look, colorScheme).toEqual({
      importBorder: 'dashed',
      radius: '12px',
      padding: '16px',
      button: 34,
      choose: 34,
      gap: 12,
    });
    const { violations } = await new AxeBuilder({ page }).include('section#share').analyze();
    expect
      .soft(
        violations.map((violation) => violation.id),
        colorScheme,
      )
      .toEqual([]);
  }
});
