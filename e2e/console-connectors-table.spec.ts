import { expect, test } from '@playwright/test';
import { WORKER_ORIGIN } from './pin.ts';
import { box, contrast, fulfillSites, painted, rgb, sideScroll, styles, LUMEN } from './console-workspace.ts';
import {
  CONSOLE,
  LINE,
  CHIP,
  HOVER,
  ACCENT,
  ACCENT_STRONG,
  DONE,
  LINEAR,
  ADDRESS,
  PLACE,
  SITES,
  LATE,
  workerWith,
  open,
  rows,
  settingsOf,
  panel,
  catalogue,
  tiles,
  failing,
  openSettings,
  expectNoViolation,
} from './console-connectors-stub.ts';
import { unfolded } from './settled.ts';

/**
 * The table of the Connectors screen (FRU-690): a row for each connector with its logo, its account,
 * the sites that use it and its health, « Retry », the red count of the bar, and the settings of a
 * connector in a dialog. The values are those of the mockup of FRU-690 (« Maquette HTML ·
 * Connecteurs »), on the tokens of the console. The catalogue is in
 * `console-connectors-catalogue.spec.ts`. The worker is answered by stubs.
 */
test('the table of the connectors, and the settings of a Linear in their dialog', async ({ page }) => {
  await workerWith(page);
  await open(page);
  await expect(
    page.getByText('Connect a tracker once. Every site of Acme can then send its notes there.'),
  ).toBeVisible();

  // « Your connectors » and how many.
  const title = page.getByRole('heading', { level: 2, name: /^Your connectors/ });
  await expect(title).toHaveText('Your connectors2');
  expect.soft(await styles(title, ['font-size', 'font-weight'])).toEqual({ 'font-size': '13px', 'font-weight': '600' });

  // A table: the connector with its logo, its account, the sites that use it, its health.
  await expect(page.locator('.kit-table thead th')).toHaveText([
    'Connector',
    'Account',
    'Used by',
    'Health',
    'Actions',
  ]);
  await expect(rows(page)).toHaveCount(2);
  const linear = rows(page).first();
  await expect(linear.locator('td')).toHaveText(['Linear', 'Workspace Acme', '2 sites', 'Connected', '']);
  await expect(rows(page).nth(1).locator('td').nth(1)).toHaveText('hooks.acme.dev/feedback');

  // The logo is a file the console serves itself, in its box of 24 px, 14 px inside.
  const logo = linear.locator('img[data-logo="linear"]');
  await expect(logo).toHaveAttribute('src', '/logos/linear.svg');
  await expect(logo).toHaveAttribute('alt', '');
  expect(await logo.evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(true);
  expect.soft(await styles(logo, ['width', 'height'])).toEqual({ width: '14px', height: '14px' });
  const frame = logo.locator('..');
  await expect(frame).toHaveAttribute('aria-hidden', 'true');
  expect.soft(await styles(frame, ['width', 'height', 'border-top-left-radius'])).toEqual({
    width: '24px',
    height: '24px',
    'border-top-left-radius': '6px',
  });
  expect.soft(await painted(frame, 'borderTopColor')).toEqual(rgb(LINE));
  await expect(rows(page).nth(1).locator('img[data-logo="rest"]')).toHaveAttribute('src', '/logos/rest.svg');

  // A tracker says « Connected »: the worker does not say yet whether its notes arrived (FRU-714).
  const state = linear.locator('[data-pill]');
  expect.soft(await styles(state, ['font-size', 'font-weight', 'height'])).toEqual({
    'font-size': '12px',
    'font-weight': '600',
    height: '20px',
  });
  expect.soft(await painted(state, 'color')).toEqual(rgb(DONE));
  expect
    .soft(contrast(rgb(DONE), await painted(state, 'backgroundColor')), 'the green on its tint')
    .toBeGreaterThanOrEqual(4.5);

  // A press of « … » opens the settings in a dialog named after the connector. No accordion any more.
  const opener = settingsOf(page, 'Linear');
  await openSettings(page, 'Linear');
  const dialog = page.getByRole('dialog', { name: 'Linear' });
  await expect(dialog).toBeVisible();
  await expect(panel(page)).toHaveAttribute('aria-label', 'Linear · Workspace Acme');
  await expect(linear).toHaveAttribute('data-chosen', 'true');
  const card = panel(page).locator('aside');
  await expect(card.getByText('Connected to the workspace Acme')).toBeVisible();

  // The sites that send here, each with its places, read only: a site chooses them on the Sites
  // screen (FRU-399), which the block leads to.
  await expect(card.locator('[data-site]')).toHaveCount(2);
  await expect(card.locator('[data-site="support.acme.dev"]')).toHaveCount(0);
  await expect(card.getByText('Each site chooses where its notes go, on the Sites screen.')).toBeVisible();
  await expect(card.getByRole('link', { name: 'Open the sites' })).toHaveAttribute('href', '/w/w1/sites');
  // The statuses of each site, on its row (FRU-478).
  await expect(card.getByRole('heading', { level: 3 })).toHaveText(['Sites sending here']);
  await expect(card.getByRole('link', { name: /^Statuses of / })).toHaveText(['Statuses', 'Statuses']);
  await expect(
    card.locator('[data-site="staging.acme.dev"]').getByRole('link', { name: 'Statuses of https://staging.acme.dev' }),
  ).toHaveAttribute('href', '/w/w1/sites/s1/statuses');
  await expect(card.getByRole('switch', { name: 'Show Linear comments as replies' })).toBeChecked();
  await expect(card.getByRole('button', { name: 'Disconnect Linear', exact: true })).toBeVisible();
  await expectNoViolation(page, 'the settings of a Linear', '[role="dialog"]');

  // Escape closes it, and focus goes back to the button that opened it.
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(opener).toBeFocused();
  // A press on the row opens them too.
  await linear.locator('td').nth(1).click();
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expectNoViolation(page, 'the table');
});

test('an address says how many sends wait, « Retry » sends them again, and the bar counts them', async ({ page }) => {
  const worker = await workerWith(page);
  await open(page);
  const address = rows(page).nth(1);
  const state = address.getByText('2 notes not delivered', { exact: true });
  await expect(state).toBeVisible();
  // The strong red: the accent is under 4.5:1 on a tint (FRU-683).
  expect.soft(await painted(state, 'color')).toEqual(rgb(ACCENT_STRONG));
  expect
    .soft(contrast(rgb(ACCENT_STRONG), await painted(state, 'backgroundColor')), 'the red on its tint')
    .toBeGreaterThanOrEqual(4.5);
  await address.hover();
  expect.soft(await painted(address, 'backgroundColor')).toEqual(rgb(HOVER));
  expect
    .soft(contrast(rgb(ACCENT_STRONG), rgb(HOVER)), 'the red on a row under the pointer')
    .toBeGreaterThanOrEqual(4.5);
  expect(contrast(rgb(ACCENT), rgb(CHIP)), 'the control: the accent would not do').toBeLessThan(4.5);

  // The red count of « Connectors » in the bar follows them.
  await expect(failing(page)).toHaveText('failed sends:2');

  // The settings of the address list them, as before.
  await openSettings(page, 'REST API');
  await expect(panel(page).getByRole('heading', { level: 2, name: 'REST API', exact: true })).toBeAttached();
  await expect(panel(page).getByText('Your receiver answered 500')).toBeVisible();
  await expect(panel(page).getByRole('button', { name: 'Try now' })).toHaveCount(2);
  await page.keyboard.press('Escape');

  // « Retry » asks each of them again, then reads the health again.
  worker.late = [];
  await address.getByRole('button', { name: 'Retry REST API', exact: true }).click();
  await expect(address.getByText('Healthy', { exact: true })).toBeVisible();
  expect(worker.sent.map((each) => each.pathname)).toEqual([
    '/console/workspaces/w1/connectors/r1/deliveries/d1/retry',
    '/console/workspaces/w1/connectors/r1/deliveries/d2/retry',
  ]);
  await expect(address.getByRole('button', { name: /^Retry/ })).toHaveCount(0);
  await expect(failing(page)).toHaveCount(0);

  // One note: the singular.
  worker.late = LATE.slice(0, 1);
  await open(page);
  await expect(rows(page).nth(1).getByText('1 note not delivered', { exact: true })).toBeVisible();
  await expect(failing(page)).toHaveText('failed sends:1');
});

test('the count of the bar stays on another screen, and goes with a change of workspace', async ({ page }) => {
  const worker = await workerWith(page, 'owner', 'en', [LUMEN]);
  await open(page);
  await expect(failing(page)).toHaveText('failed sends:2');
  // Another screen of the same workspace keeps the count the Connectors screen read.
  await page.locator('aside').getByRole('link', { name: 'Sites', exact: true }).click();
  await expect(page).toHaveURL(`${CONSOLE}/w/w1/sites`);
  await expect(failing(page)).toHaveText('failed sends:2');
  // Another workspace, then back: a count read before could be old, so the bar counts nothing until
  // the Connectors screen reads it again (raised in review).
  const switcher = () => page.locator('aside').getByRole('button', { name: /^(Acme|Lumen Studio)/ });
  await switcher().click();
  await page.getByRole('menuitemradio', { name: /Lumen Studio/ }).click();
  await expect(page).toHaveURL(`${CONSOLE}/w/w2/sites`);
  await expect(failing(page)).toHaveCount(0);
  await switcher().click();
  await page.getByRole('menuitemradio', { name: /Acme/ }).click();
  await expect(page).toHaveURL(`${CONSOLE}/w/w1/sites`);
  await expect(failing(page)).toHaveCount(0);
  worker.late = LATE.slice(0, 1);
  await page
    .locator('aside')
    .getByRole('link', { name: /^Connectors/ })
    .click();
  await expect(failing(page)).toHaveText('failed sends:1');
});

test('a « Retry » that the worker refuses in part says so until the next read', async ({ page }) => {
  const worker = await workerWith(page);
  await open(page);
  const address = rows(page).nth(1);
  // The first send goes again, the second is refused: the screen says it, and reads the health again.
  worker.refusesRetry = ['d2'];
  worker.late = LATE.slice(1);
  await address.getByRole('button', { name: 'Retry REST API', exact: true }).click();
  const refusal = page.locator('main').getByRole('alert');
  await expect(refusal).toHaveText('The new attempt was not started. Try again.');
  await expect(address.locator('[data-pill]')).toHaveText('1 note not delivered');
  await expect(failing(page)).toHaveText('failed sends:1');
  // The next read says the health as it is now, and the refusal of before goes.
  worker.refusesRetry = [];
  worker.late = [];
  await address.getByRole('button', { name: 'Retry REST API', exact: true }).click();
  await expect(address.locator('[data-pill]')).toHaveText('Healthy');
  await expect(refusal).toHaveCount(0);

  // Two refusals are counted. A send that arrived meanwhile (`not-found`) needs no new attempt, and
  // is no refusal (raised in review).
  worker.late = [...LATE, { ...LATE[0], id: 'd3' }];
  await open(page);
  worker.refusesRetry = ['d1', 'd2'];
  worker.arrived = ['d3'];
  await address.getByRole('button', { name: 'Retry REST API', exact: true }).click();
  await expect(refusal).toHaveText('2 new attempts were not started. Try again.');
  worker.refusesRetry = [];
  worker.late = [{ ...LATE[0], id: 'd3' }];
  await open(page);
  await address.getByRole('button', { name: 'Retry REST API', exact: true }).click();
  await expect(address.locator('[data-pill]')).toHaveText('1 note not delivered');
  await expect(refusal).toHaveCount(0);
});

test('a read of the sends that fails keeps the count of the bar, and gives no smaller one', async ({ page }) => {
  const worker = await workerWith(page);
  await open(page);
  await expect(failing(page)).toHaveText('failed sends:2');
  // The settings of the address read the list again (« Try now »), and the read of the health fails.
  await openSettings(page, 'REST API');
  worker.late = undefined;
  await panel(page).getByRole('button', { name: 'Try now' }).first().click();
  await page.keyboard.press('Escape');
  await expect(rows(page).nth(1).locator('[data-pill]')).toHaveText('Not read');
  await expect(failing(page)).toHaveText('failed sends:2');
});

test('the sends of an address that were not read are « Not read », and the screen says so', async ({ page }) => {
  const worker = await workerWith(page);
  worker.late = undefined;
  await open(page);
  const address = rows(page).nth(1);
  // Never « Healthy »: the screen does not know.
  await expect(address.locator('[data-pill]')).toHaveText('Not read');
  await expect(address.getByText('Healthy')).toHaveCount(0);
  await expect(page.getByRole('alert')).toHaveText(
    'The health of some connectors did not load. Fruitback hit an error.',
  );
  await openSettings(page, 'REST API');
  await expect(panel(page).getByText('Fruitback hit an error. Try again in a moment.')).toBeVisible();
  await expect(panel(page).getByText('Every note arrived.')).toHaveCount(0);
  await page.keyboard.press('Escape');

  // « Try again » reads them again.
  worker.late = [];
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(address.locator('[data-pill]')).toHaveText('Healthy');
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('a connector that its tracker refuses, or a place it refused, says so in red', async ({ page }) => {
  const worker = await workerWith(page);
  worker.connectors = [
    { ...LINEAR, label: 'Linear · Ana', attention: { reason: 'key-refused', since: '2026-10-10T10:00:00.000Z' } },
    ADDRESS,
  ];
  await open(page);
  const state = rows(page).first().locator('[data-pill]');
  await expect(state).toHaveText('Needs attention');
  expect.soft(await painted(state, 'color')).toEqual(rgb(ACCENT_STRONG));
  await openSettings(page, 'Linear');
  await expect(panel(page).getByRole('alert').first()).toContainText('Linear refuses this connection since');
  await expect(panel(page).getByText('Connected with the key of Ana')).toBeVisible();
});

test('a place of a site that the tracker refused makes its connector « Needs attention » (FRU-640)', async ({
  page,
}) => {
  await workerWith(page);
  await page.route(
    `${WORKER_ORIGIN}/console/workspaces/w1/sites*`,
    (route) =>
      fulfillSites(route, [
        {
          ...SITES[0],
          destinations: [{ ...PLACE, attention: { reason: 'place-gone', since: '2026-11-20T10:00:00Z' } }],
        },
      ]) || route.fallback(),
  );
  await open(page);
  await expect(rows(page).first().locator('[data-pill]')).toHaveText('Needs attention');
  await expect(rows(page).nth(1).locator('[data-pill]')).toHaveText('2 notes not delivered');
});

test('a connection that Linear ended is reconnected from its settings, and keeps its sites (FRU-633)', async ({
  page,
}) => {
  const worker = await workerWith(page);
  const ended = { ...LINEAR, attention: { reason: 'connection-ended', since: '2026-11-12T09:54:53.000Z' } };
  worker.connectors = [ended, ADDRESS];
  await open(page);
  await openSettings(page, 'Linear');
  const alert = panel(page).getByRole('alert').first();
  await expect(alert).toContainText('Linear ended this connection, and since');
  await expect(alert).toContainText('Reconnect it: its sites and its settings stay as they are.');

  await panel(page).getByRole('button', { name: 'Reconnect Linear', exact: true }).click();

  // Back from Linear, the settings of the connector open by themselves, with what happened.
  await expect(page).toHaveURL(`${CONSOLE}/w/w1/connectors`);
  expect(worker.sent.map((each) => each.pathname)).toContain('/console/workspaces/w1/connectors/c1/reconnect');
  await expect(panel(page).getByRole('status')).toHaveText(
    'Linear is connected again. Its sites send their notes to the same places.',
  );
  await expect(panel(page).getByRole('alert')).toHaveCount(0);
  await expect(rows(page).first().locator('[data-pill]')).toHaveText('Connected');
});

test('a member reads that a connection ended, and is not offered to reconnect it (FRU-633)', async ({ page }) => {
  const worker = await workerWith(page, 'member');
  worker.connectors = [{ ...LINEAR, attention: { reason: 'connection-ended', since: '2026-11-12T09:54:53.000Z' } }];
  await open(page);
  await openSettings(page, 'Linear');
  await expect(panel(page).getByRole('alert').first()).toContainText(
    'An owner or an admin of the workspace can reconnect it here.',
  );
  await expect(panel(page).getByRole('button', { name: 'Reconnect Linear' })).toHaveCount(0);
});

test('a consent for another workspace of Linear says so in the settings of the connector (FRU-633)', async ({
  page,
}) => {
  await workerWith(page);
  await page.goto(`${CONSOLE}/w/w1/connectors?linear=other-organization&connector=c1`);
  await expect(panel(page).getByRole('alert').first()).toHaveText(
    'This connector did not change: you chose another workspace of Linear at Linear. Reconnect it, and choose its workspace of Linear.',
  );
  await expect(page).toHaveURL(`${CONSOLE}/w/w1/connectors`);
});

test('with no connector, and with a read that failed, the screen says which of the two it is', async ({ page }) => {
  const worker = await workerWith(page);
  worker.connectors = [];
  await open(page);
  await expect(page.getByText('No tracker yet. The notes stay in Fruitback.')).toBeVisible();
  await expect(rows(page)).toHaveCount(0);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(tiles(page)).toHaveCount(12);
  await expect(page.getByRole('heading', { level: 2, name: /^Your connectors/ })).toHaveCount(0);
  // The catalogue is on the screen: no « New connector » leads to it.
  await expect(page.getByRole('button', { name: 'New connector', exact: true })).toHaveCount(0);
  await expectNoViolation(page, 'no connector');

  // A read that failed is not « no tracker »: it says so, and reads again.
  worker.down = true;
  await open(page);
  await expect(page.getByRole('alert')).toHaveText(
    'The connectors and their sites did not load. Fruitback hit an error.',
  );
  await expect(page.getByText('No tracker yet. The notes stay in Fruitback.')).toHaveCount(0);
  // Nothing to add while the list is not read: the screen does not know how this worker connects
  // Linear, by the consent at Linear or by a key.
  await expect(catalogue(page)).toHaveCount(0);
  worker.down = false;
  worker.connectors = [LINEAR, ADDRESS];
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(rows(page)).toHaveCount(2);
  await expect(page.getByRole('alert')).toHaveCount(0);
  // The control of the count above: once read, the catalogue is there.
  await expect(tiles(page)).toHaveCount(12);
});

test('a link of the settings leads to the statuses of its site (FRU-368)', async ({ page }) => {
  await workerWith(page);
  await open(page);
  await openSettings(page, 'Linear');
  await panel(page).getByRole('link', { name: 'Statuses of https://staging.acme.dev' }).click();
  await expect(page).toHaveURL(/\/w\/w1\/sites\/s1\/statuses$/);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Statuses');
});

test('a long address keeps one line in its row, cut at its end (FRU-321)', async ({ page }) => {
  const long = 'REST · hooks.a-very-long-subdomain-of-the-receiver.staging.acme-corporation.dev/feedback/notes';
  const worker = await workerWith(page);
  worker.connectors = [LINEAR, { ...ADDRESS, label: long }];
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await open(page);
    const line = rows(page).nth(1).locator('[data-source-line]');
    const fontSize = await line.evaluate((element) => parseFloat(getComputedStyle(element).fontSize));
    expect((await box(line)).height, `${width} px`).toBeLessThan(fontSize * 2);
    expect(await line.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
    await expect(line).toHaveAttribute('title', long.replace(/^REST · /, ''));
    expect(await sideScroll(page), `${width} px`).toBe(0);
  }
});

for (const locale of ['en', 'fr'] as const) {
  test(`at 390 px nothing scrolls sideways, with the settings open, in ${locale}`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await workerWith(page, 'owner', locale);
    await open(page);
    expect.soft(await sideScroll(page), 'the table and the catalogue').toBe(0);
    // A row is a card under 680 px (FRU-505): its words are one under the other.
    await expect(page.locator('.kit-table')).toHaveAttribute('data-stacked', 'true');
    for (const name of ['Linear', locale === 'en' ? 'REST API' : 'API REST']) {
      await page
        .getByRole('button', { name: `${locale === 'en' ? 'Settings of' : 'Réglages de'} ${name}`, exact: true })
        .click();
      await unfolded(page);
      const dialog = await box(page.getByRole('dialog'));
      expect.soft(dialog.x).toBeGreaterThanOrEqual(0);
      expect.soft(dialog.x + dialog.width).toBeLessThanOrEqual(390);
      await expectNoViolation(page, `the settings of ${name} at 390 px`, '[role="dialog"]');
      await page.keyboard.press('Escape');
      await expect(page.getByRole('dialog')).toHaveCount(0);
    }
    // One tile in a row.
    for (const each of await tiles(page).all())
      expect.soft((await box(each)).x + (await box(each)).width).toBeLessThanOrEqual(390);
    await page
      .getByRole('button', { name: locale === 'en' ? 'Connect another REST API' : 'Connecter un autre API REST' })
      .click();
    expect.soft(await sideScroll(page), 'the form of an address').toBe(0);
    await expectNoViolation(page, `390 px in ${locale}`);
  });
}

/**
 * FRU-404. Several connectors can reach one tracker, so an owner or an admin names each one in its
 * settings, and the name is what its row shows. An empty name gives it back the name of its kind.
 */
for (const { width, height, locale, words } of [
  {
    width: 1440,
    height: 900,
    locale: 'en',
    words: {
      settings: 'Settings of',
      rename: 'Rename Linear',
      field: 'Name of this connector',
      save: 'Save',
      refused: 'A name of one line, up to 80 characters.',
    },
  },
  {
    width: 390,
    height: 844,
    locale: 'fr',
    words: {
      settings: 'Réglages de',
      rename: 'Renommer Linear',
      field: 'Nom de ce connecteur',
      save: 'Enregistrer',
      refused: 'Un nom d’une ligne, de 80 caractères au plus.',
    },
  },
] as const) {
  test(`an owner names a connector, and its row says the name, at ${width} px in ${locale}`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    const worker = await workerWith(page, 'owner', locale);
    worker.connectors = [LINEAR, { ...LINEAR, id: 'c2', label: 'Linear · Ana' }, ADDRESS];
    await open(page);
    const row = rows(page).first();
    const name = row.locator('td').first();
    await row.getByRole('button', { name: `${words.settings} Linear`, exact: true }).click();
    await unfolded(page);

    // A refused name keeps the form open, with what was typed.
    await panel(page).getByRole('button', { name: words.rename, exact: true }).click();
    const field = panel(page).getByRole('textbox', { name: words.field });
    await expect(field).toBeFocused();
    await field.fill('Clients');
    worker.refusesName = 'invalid-name';
    await panel(page).getByRole('button', { name: words.save, exact: true }).click();
    await expect(panel(page).getByText(words.refused)).toBeVisible();
    await expect(field).toHaveValue('Clients');

    worker.refusesName = undefined;
    await field.fill('  Clients  ');
    await field.press('Enter');
    await expect(name).toHaveText('Clients');
    expect(worker.sent.at(-1)).toEqual({ pathname: '/console/workspaces/w1/connectors/c1', body: { name: 'Clients' } });
    // The kind goes first in its account, so that a name never hides what the connector is.
    await expect(row.locator('[data-source-line]')).toHaveText(/^Linear · /);
    // The dialog is named after it too.
    await expect(page.getByRole('dialog', { name: 'Clients' })).toBeVisible();
    // The neighbour of the same kind keeps its own name.
    await expect(rows(page).nth(1).locator('td').first()).toHaveText('Linear');
    await expect(panel(page).getByRole('button', { name: /Clients$/ })).toBeFocused();
    await expectNoViolation(page, `named, ${width} px`, '[role="dialog"]');

    // Escape in the form closes the form, not the dialog.
    await panel(page)
      .getByRole('button', { name: /Clients$/ })
      .click();
    await page.keyboard.press('Escape');
    await expect(panel(page)).toBeVisible();

    // An empty name gives the connector back the name of its kind.
    await panel(page)
      .getByRole('button', { name: /Clients$/ })
      .click();
    await panel(page).getByRole('textbox', { name: words.field }).fill('');
    await panel(page).getByRole('button', { name: words.save, exact: true }).click();
    await expect(name).toHaveText('Linear');
    expect(worker.sent.at(-1)?.body).toEqual({ name: '' });
  });
}

test('« Rename » starts from the name of the last read, not the one of when the settings opened', async ({ page }) => {
  const worker = await workerWith(page);
  await open(page);
  await openSettings(page, 'REST API');
  // Another admin names it meanwhile; « Try now » of a late note reads the list again.
  worker.connectors = [LINEAR, { ...ADDRESS, name: 'Support' }];
  await panel(page).getByRole('button', { name: 'Try now' }).first().click();
  await expect(rows(page).nth(1).locator('td').first()).toHaveText('Support');
  await panel(page).getByRole('button', { name: 'Rename Support', exact: true }).click();
  await expect(panel(page).getByRole('textbox', { name: 'Name of this connector' })).toHaveValue('Support');
});

test('a member reads the name of a connector, and renames none', async ({ page }) => {
  const worker = await workerWith(page, 'member');
  worker.connectors = [{ ...LINEAR, name: 'Clients' }, ADDRESS];
  await open(page);
  await expect(rows(page).first().locator('td').first()).toHaveText('Clients');
  await openSettings(page, 'Clients');
  await expect(panel(page).getByText('Clients', { exact: true })).toBeVisible();
  await expect(panel(page).getByRole('button', { name: /^Rename/ })).toHaveCount(0);
});
