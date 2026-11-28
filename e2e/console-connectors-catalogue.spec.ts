import { expect, test } from '@playwright/test';
import { WORKER_ORIGIN } from './pin.ts';
import { box, painted, rgb, styles } from './console-workspace.ts';
import {
  CONSOLE,
  MUTED,
  LINE,
  LINEAR,
  ADDRESS,
  DONE,
  workerWith,
  open,
  rows,
  panel,
  catalogue,
  tiles,
  tile,
  search,
  CATALOGUE,
  openSettings,
  expectNoViolation,
} from './console-connectors-stub.ts';

/**
 * The catalogue of the Connectors screen (FRU-690): a tile for each kind with its logo, one line and
 * its state, the search and the groups, the forms that open in a tile, and who may connect. The
 * values are those of the mockup of FRU-690, on the tokens of the console. The worker is answered by
 * stubs.
 */
test('the catalogue: a tile for each tracker, its logo, one line, and its state', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const worker = await workerWith(page);
  worker.connectors = [ADDRESS];
  await open(page);
  await expect(tiles(page)).toHaveCount(12);
  for (const [index, [name, kind]] of CATALOGUE.entries()) {
    const each = tiles(page).nth(index);
    await expect(each, name).toHaveAttribute('data-source', name);
    await expect(each.locator(`img[data-logo="${kind}"]`), kind).toHaveAttribute('src', `/logos/${kind}.svg`);
  }
  // Every logo is drawn: each file is served by the console itself.
  for (const image of await catalogue(page).locator('img[data-logo]').all()) {
    expect(await image.evaluate((each: HTMLImageElement) => each.complete && each.naturalWidth > 0)).toBe(true);
  }

  // A tile of 64 px: the logo in its box of 36 px, 20 px inside; four in a row at 1440 px.
  const first = tile(page, 'Linear');
  expect.soft(await styles(first, ['height', 'border-top-left-radius', 'border-top-width'])).toEqual({
    height: '64px',
    'border-top-left-radius': '8px',
    'border-top-width': '1px',
  });
  expect.soft(await painted(first, 'borderTopColor')).toEqual(rgb(LINE));
  const frame = first.locator('img').locator('..');
  expect.soft(await styles(frame, ['width', 'height'])).toEqual({ width: '36px', height: '36px' });
  expect.soft(await styles(first.locator('img'), ['width', 'height'])).toEqual({ width: '20px', height: '20px' });
  const boxes = await Promise.all([0, 1, 2, 3, 4].map(async (index) => box(tiles(page).nth(index))));
  for (const index of [1, 2, 3]) expect(boxes[index]!.y, `tile ${index + 1}`).toBe(boxes[0]!.y);
  expect(boxes[4]!.y).toBeGreaterThan(boxes[0]!.y);
  expect.soft(await styles(catalogue(page).getByRole('list'), ['row-gap', 'column-gap'])).toEqual({
    'row-gap': '10px',
    'column-gap': '10px',
  });

  // One line of what a note becomes there, cut at its end; the whole sentence is the tooltip.
  const line = tile(page, 'Webhook').locator('[data-tile-line]');
  await expect(line).toHaveText('Tells any address when a note arrives');
  expect.soft(await styles(line, ['white-space', 'text-overflow', 'overflow-x'])).toEqual({
    'white-space': 'nowrap',
    'text-overflow': 'ellipsis',
    'overflow-x': 'hidden',
  });
  expect(await line.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
  await expect(line.locator('..')).toHaveAttribute('title', 'Tells Slack or any address when a note arrives.');
  expect.soft(await painted(line, 'color')).toEqual(rgb(MUTED));

  // The states: « Add » with a count (FRU-727), « Connect », « Soon », and the « New » of the routine.
  await expect(tile(page, 'REST API')).toHaveAttribute('data-state', 'connected');
  await expect(tile(page, 'REST API').locator('[data-pill]')).toHaveCount(0);
  await expect(tile(page, 'REST API').locator('[data-count]')).toHaveText('1');
  await expect(tile(page, 'REST API').getByRole('button', { name: 'Add another REST API (1 connected)' })).toHaveText(
    'Add',
  );
  for (const name of ['Jira', 'GitLab', 'Asana', 'ClickUp', 'Trello', 'Notion', 'Slack', 'Webhook']) {
    // No plugin of this kind on this worker: nothing here connects.
    await expect(tile(page, name).locator('[data-pill]'), name).toHaveText('Soon');
    await expect(tile(page, name).getByRole('button'), name).toHaveCount(0);
  }
  const connect = tile(page, 'GitHub Issues').getByRole('button', { name: 'Connect GitHub Issues', exact: true });
  // The worker of these stubs has no GitHub App: the tile says so, and connects nothing.
  await expect(connect).toHaveCount(0);
  await expect(tile(page, 'GitHub Issues').locator('[data-pill]')).toHaveText('Not set up');
  await expect(tile(page, 'GitHub Issues').locator('[data-tile-line]')).toHaveText(
    'The operator of this Fruitback has not set up the GitHub App.',
  );
  await expect(tile(page, 'Claude Code routine').locator('[data-pill]')).toHaveText('New');
  const routine = tile(page, 'Claude Code routine').getByRole('button', { name: 'Connect Claude Code routine' });
  expect.soft(await styles(routine, ['height', 'font-size'])).toEqual({ height: '24px', 'font-size': '12px' });

  // Linear connects by the consent at Linear, and its key is the other way, in a menu.
  await expect(tile(page, 'Linear').getByRole('button', { name: 'Connect Linear', exact: true })).toBeVisible();
  await tile(page, 'Linear').getByRole('button', { name: 'Other ways to connect Linear' }).click();
  await page.getByRole('menuitem', { name: 'Use an API key' }).click();
  await expect(tile(page, 'Linear').getByLabel('Linear API key')).toBeVisible();
  // The tile of the form takes the whole row.
  expect((await box(tile(page, 'Linear'))).width).toBeGreaterThan(boxes[0]!.width * 3);
  await tile(page, 'Linear').getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(tile(page, 'Linear').getByLabel('Linear API key')).toHaveCount(0);
  await expectNoViolation(page, 'the catalogue');
});

test('the catalogue searches its tiles, and shows one kind at a time', async ({ page }) => {
  await workerWith(page);
  await open(page);
  const names = () => tiles(page).evaluateAll((items) => items.map((item) => item.getAttribute('data-source')));
  await search(page).fill('git');
  await expect.poll(names).toEqual(['GitHub Issues', 'GitLab']);
  // No case and no accent: « Dépôt » finds what « depot » would.
  await search(page).fill('TRELLO');
  await expect.poll(names).toEqual(['Trello']);
  await search(page).fill('zzz');
  await expect(tiles(page)).toHaveCount(0);
  await expect(catalogue(page).getByRole('status')).toHaveText('No connector matches « zzz ».');
  await search(page).fill('');

  const group = catalogue(page).getByRole('group', { name: 'Kind of connector' });
  await expect(group.getByRole('button')).toHaveText(['All kinds', 'Trackers', 'Agents', 'Developers']);
  await expect(group.getByRole('button', { name: 'All kinds' })).toHaveAttribute('aria-pressed', 'true');
  await group.getByRole('button', { name: 'Developers' }).click();
  await expect.poll(names).toEqual(['Webhook', 'REST API']);
  await group.getByRole('button', { name: 'Agents' }).click();
  await expect.poll(names).toEqual(['Claude Code routine']);
  await group.getByRole('button', { name: 'Trackers' }).click();
  await expect(tiles(page)).toHaveCount(9);
  await expect(group.getByRole('button', { name: 'Trackers' })).toHaveAttribute('aria-pressed', 'true');
});

test('an address connected from its tile shows its secret once, then its settings open', async ({ page }) => {
  const worker = await workerWith(page);
  await open(page);
  await tile(page, 'REST API')
    .getByRole('button', { name: /^Add another REST API \(/ })
    .click();
  const field = page.getByRole('textbox', { name: 'Address of your receiver' });
  // An address that the worker refuses keeps what was typed.
  worker.refuses = 'invalid-address';
  await field.fill('https://hooks.client.fr/notes');
  await tile(page, 'REST API').getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(tile(page, 'REST API').getByRole('alert')).toContainText('Fruitback cannot send to this address.');
  await expect(field).toHaveValue('https://hooks.client.fr/notes');
  await expectNoViolation(page, 'the form of an address');

  // Kept: the secret that Fruitback made is on the screen once, and the address is in the table.
  worker.refuses = undefined;
  await tile(page, 'REST API').getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(page.locator('[data-secret]')).toHaveText('made-by-fruitback-0123456789');
  await expect(rows(page)).toHaveCount(3);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  // A search or a group that does not hold the tile keeps it while its form is open: the secret is
  // shown once (raised in review).
  await search(page).fill('linear');
  await catalogue(page).getByRole('button', { name: 'Agents', exact: true }).click();
  await expect(page.locator('[data-secret]')).toHaveText('made-by-fruitback-0123456789');
  await expect(tiles(page)).toHaveCount(1);
  await page.getByRole('button', { name: 'I kept it', exact: true }).click();
  await expect(page.locator('[data-secret]')).toHaveCount(0);
  // The form closed, so the search and the group hold their tiles again.
  await expect(tiles(page)).toHaveCount(0);
  // Its settings open, and the secret is gone from the screen.
  await expect(panel(page)).toHaveAttribute('aria-label', /hooks\.client\.fr\/notes/);
  await expect(page.getByText('made-by-fruitback-0123456789')).toHaveCount(0);
});

test('a secret on the screen stays when the read after it says no connector can be added', async ({ page }) => {
  const worker = await workerWith(page);
  await open(page);
  await tile(page, 'REST API')
    .getByRole('button', { name: /^Add another REST API \(/ })
    .click();
  await page.getByRole('textbox', { name: 'Address of your receiver' }).fill('https://hooks.client.fr/notes');
  // The read that follows the address says this worker cannot keep a key any more: the buttons of
  // the catalogue go, and the form with the secret must not go with them.
  worker.unavailable = true;
  await tile(page, 'REST API').getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(rows(page)).toHaveCount(3);
  await expect(page.getByRole('button', { name: 'New connector', exact: true })).toHaveCount(0);
  await expect(page.locator('[data-secret]')).toHaveText('made-by-fruitback-0123456789');
  await page.getByRole('button', { name: 'I kept it', exact: true }).click();
  await expect(panel(page)).toBeVisible();
});

test('« New connector » and `?new` lead to the search of the catalogue', async ({ page }) => {
  await workerWith(page);
  await open(page);
  await page.getByRole('button', { name: 'New connector', exact: true }).click();
  await expect(search(page)).toBeFocused();
  await expect(catalogue(page).getByRole('heading', { name: 'Add a connector' })).toBeInViewport();

  await page.goto(`${CONSOLE}/w/w1/connectors?new=1`);
  await expect(search(page)).toBeFocused();
  await expect(page).toHaveURL(`${CONSOLE}/w/w1/connectors`);
});

test('`?new` leads nowhere for a person who cannot add a connector', async ({ page }) => {
  await workerWith(page, 'member');
  await page.goto(`${CONSOLE}/w/w1/connectors?new=1`);
  await expect(rows(page)).toHaveCount(2);
  await expect(page).toHaveURL(`${CONSOLE}/w/w1/connectors`);
  await expect(search(page)).not.toBeFocused();
  // FRU-738: with no action, the box of the actions of the head is there and draws nothing.
  const actions = page.locator('main header > div');
  await expect(actions).toHaveCount(1);
  expect(await styles(actions, ['display'])).toEqual({ display: 'none' });

  // A worker that cannot keep a key: the same, also after a later read that can.
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  const owner = await workerWith(page);
  owner.unavailable = true;
  await page.goto(`${CONSOLE}/w/w1/connectors?new=1`);
  await expect(rows(page)).toHaveCount(2);
  await expect(search(page)).not.toBeFocused();
  await expect(page.getByRole('button', { name: 'New connector', exact: true })).toHaveCount(0);
  owner.unavailable = false;
  await page.getByRole('button', { name: 'Retry REST API', exact: true }).click();
  await expect(page.getByRole('button', { name: 'New connector', exact: true })).toBeVisible();
  await expect(search(page)).not.toBeFocused();
});

test('the catalogue waits for the list of the connectors, and its buttons do not move under a press', async ({
  page,
}) => {
  const worker = await workerWith(page);
  worker.connectors = [];
  // The read is held: the screen is drawn without the list, as on a slow line.
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route(`${WORKER_ORIGIN}/console/workspaces/w1/connectors`, async (route) => {
    await held;
    await route.fallback();
  });
  await open(page);
  const connect = page.getByRole('button', { name: 'Connect REST API', exact: true });
  await expect(page.locator('main').getByText('Loading…')).toBeVisible();
  // Nothing to press yet: what « Connect Linear » does (the consent at Linear, or a key) is said by
  // the same read.
  await expect(tiles(page)).toHaveCount(0);
  await expect(connect).toHaveCount(0);

  release();
  await expect(tiles(page)).toHaveCount(12);
  await expect(rows(page)).toHaveCount(0);
  const before = await connect.boundingBox();
  await page.mouse.move(before!.x + before!.width / 2, before!.y + before!.height / 2);
  await page.mouse.down();
  await page.waitForLoadState('networkidle');
  expect(await connect.boundingBox()).toEqual(before);
  await page.mouse.up();
  await expect(page.getByRole('textbox', { name: 'Address of your receiver' })).toBeVisible();
});

test('a worker with no Linear application connects Linear by a key, and its settings open', async ({ page }) => {
  const worker = await workerWith(page);
  worker.oauth = false;
  worker.connectors = [ADDRESS];
  await open(page);
  await expect(tile(page, 'Linear').getByRole('button', { name: 'Other ways to connect Linear' })).toHaveCount(0);
  await tile(page, 'Linear').getByRole('button', { name: 'Connect Linear', exact: true }).click();
  await tile(page, 'Linear').getByLabel('Linear API key').fill('lin_api_0123456789');
  await tile(page, 'Linear').getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(rows(page)).toHaveCount(2);
  await expect(panel(page)).toHaveAttribute('aria-label', 'Linear · Key of Bo');
  await expect(tile(page, 'Linear').getByLabel('Linear API key')).toHaveCount(0);
});

test('a first address opens its settings once read, also when the read ends after « I kept it »', async ({ page }) => {
  const worker = await workerWith(page);
  worker.connectors = [];
  await open(page);
  await page.getByRole('button', { name: 'Connect REST API', exact: true }).click();
  await page.getByRole('textbox', { name: 'Address of your receiver' }).fill('https://hooks.client.fr/notes');
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route(`${WORKER_ORIGIN}/console/workspaces/w1/connectors`, async (route) => {
    if (route.request().method() === 'GET') await held;
    await route.fallback();
  });
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(page.locator('[data-secret]')).toHaveText('made-by-fruitback-0123456789');
  await page.getByRole('button', { name: 'I kept it', exact: true }).click();
  await expect(rows(page)).toHaveCount(0);
  await expect(panel(page)).toHaveCount(0);
  release();
  await expect(rows(page)).toHaveCount(1);
  await expect(panel(page)).toHaveAttribute('aria-label', /hooks\.client\.fr\/notes/);
});

test('after an address whose read failed, « Cancel » of the next form closes only the form', async ({ page }) => {
  const worker = await workerWith(page);
  await open(page);
  await tile(page, 'REST API')
    .getByRole('button', { name: /^Add another REST API \(/ })
    .click();
  await page.getByRole('textbox', { name: 'Address of your receiver' }).fill('https://hooks.client.fr/notes');
  await page.getByLabel('Secret (optional)').fill('my-own-secret-0123456789');
  // The address is kept with a secret of its own, and the read that follows fails: no settings open.
  worker.down = true;
  await tile(page, 'REST API').getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('The connectors and their sites did not load.');
  await expect(panel(page)).toHaveCount(0);
  worker.down = false;
  await tile(page, 'REST API')
    .getByRole('button', { name: /^Add another REST API \(/ })
    .click();
  await tile(page, 'REST API').getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Address of your receiver' })).toHaveCount(0);
  await expect(panel(page)).toHaveCount(0);
});

test('a member reads the connectors and the catalogue, and changes nothing', async ({ page }) => {
  const worker = await workerWith(page, 'member');
  worker.connectors = [];
  await open(page);
  await expect(page.getByText('An owner or an admin adds a connector')).toBeVisible();
  await expect(tiles(page)).toHaveCount(12);
  // No button that does nothing: the line above says who adds one.
  await expect(catalogue(page).getByRole('button', { name: /^Connect/ })).toHaveCount(0);
  worker.connectors = [LINEAR, ADDRESS];
  await open(page);
  await expect(rows(page)).toHaveCount(2);
  await expect(page.getByRole('button', { name: 'New connector', exact: true })).toHaveCount(0);
  await expect(
    rows(page)
      .nth(1)
      .getByRole('button', { name: /^Retry/ }),
  ).toHaveCount(0);
  await openSettings(page, 'Linear');
  await expect(panel(page).getByRole('heading', { level: 3, name: 'Sites sending here' })).toBeVisible();
  await expect(panel(page).locator('[data-site]')).toHaveCount(2);
  await expect(panel(page).getByRole('link', { name: /^Statuses of / })).toHaveCount(0);
  await expect(panel(page).getByRole('button')).toHaveCount(0);
  await expect(panel(page).getByRole('switch')).toHaveCount(0);
});

/**
 * FRU-727. A workspace connects a kind more than once: two workspaces of Linear, two addresses. The
 * table has a row for each connection, told apart by its account, and the tile of the kind counts
 * them on its logo and offers « Add » in place of « Connected », so its words have their room.
 */
test('several connections of one kind: a row each, a count on the logo, and « Add »', async ({ page }) => {
  const worker = await workerWith(page);
  worker.connectors = [LINEAR, { ...LINEAR, id: 'c2', label: 'Linear OAuth · Acme Labs' }, ADDRESS];
  await open(page);
  await expect(rows(page)).toHaveCount(3);
  await expect(rows(page).locator('[data-source-line]')).toHaveText([
    'Workspace Acme',
    'Workspace Acme Labs',
    'hooks.acme.dev/feedback',
  ]);

  const linear = tile(page, 'Linear');
  const add = linear.getByRole('button', { name: 'Add another Linear (2 connected)', exact: true });
  await expect(add).toHaveText('Add');
  expect.soft(await styles(add, ['height', 'font-size'])).toEqual({ height: '24px', 'font-size': '12px' });
  await expect(linear.locator('[data-pill]')).toHaveCount(0);
  await expect(
    tile(page, 'REST API').getByRole('button', { name: 'Add another REST API (1 connected)' }),
  ).toBeVisible();

  // The count: a green disc on the top right corner of the logo, which a screen reader does not read
  // twice (the button says it).
  const count = linear.locator('[data-count]');
  await expect(count).toHaveText('2');
  await expect(count).toHaveAttribute('aria-hidden', 'true');
  await expect(linear.locator('.sr-only')).toHaveCount(0);
  expect.soft(await painted(count, 'backgroundColor')).toEqual(rgb(DONE));
  const logo = await box(linear.locator('img[data-logo="linear"]').locator('..'));
  const disc = await box(count);
  expect.soft(Math.abs(disc.x + disc.width / 2 - (logo.x + logo.width))).toBeLessThanOrEqual(3);
  expect.soft(Math.abs(disc.y + disc.height / 2 - logo.y)).toBeLessThanOrEqual(3);
  expect.soft({ width: disc.width, height: disc.height }).toEqual({ width: 16, height: 16 });

  // The words of a connected tile have their room at 1440 px: « An issue in a team » is no longer cut
  // by « Connected » and « + ». (A longer line, as the one of an address, is still cut at its end.)
  const line = linear.locator('[data-tile-line]');
  await expect(line).toHaveText('An issue in a team');
  expect(await line.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);

  // « Add » does what « Connect » does: the consent at Linear for a second workspace of Linear. While
  // the browser leaves, the button is named by the words it shows, not by the label of « Add ».
  let leave = () => {};
  const left = new Promise<void>((resolve) => (leave = resolve));
  await page.route(`${WORKER_ORIGIN}/console/workspaces/w1/connectors/linear/oauth`, async (route) => {
    await left;
    await route.fallback();
  });
  await add.click();
  const going = linear.getByRole('button', { name: 'Going to Linear…', exact: true });
  await expect(going).toBeDisabled();
  await expect(linear.getByRole('button', { name: /^Add another Linear/ })).toHaveCount(0);
  // The count is then said in words, since the button no longer says it.
  await expect(linear.locator('.sr-only')).toHaveText('2 connected');
  leave();
  await expect
    .poll(() => worker.sent.map((each) => each.pathname))
    .toContain('/console/workspaces/w1/connectors/linear/oauth');
});

test('« Add » of an address opens its form, and a member reads the count with « Connected »', async ({ page }) => {
  const worker = await workerWith(page);
  worker.connectors = [LINEAR, ADDRESS, { ...ADDRESS, id: 'r2', label: 'REST · n8n.acme.dev/notes' }];
  await open(page);
  await tile(page, 'REST API').getByRole('button', { name: 'Add another REST API (2 connected)' }).click();
  await expect(tile(page, 'REST API').getByRole('button', { name: 'Cancel', exact: true })).toBeVisible();
  await expectNoViolation(page, 'the form of a third address');

  // A member adds nothing: « Connected » and the count, which a screen reader hears in words.
  const member = await workerWith(page, 'member');
  member.connectors = worker.connectors;
  await open(page);
  const rest = tile(page, 'REST API');
  await expect(rest.getByRole('button')).toHaveCount(0);
  await expect(rest.locator('[data-pill]')).toHaveText('Connected');
  await expect(rest.locator('[data-count]')).toHaveText('2');
  await expect(rest.locator('.sr-only')).toHaveText('2 connected');
  await expect(tile(page, 'Linear').locator('.sr-only')).toHaveText('1 connected');
});
