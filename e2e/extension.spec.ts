import fs from 'node:fs';
import path from 'node:path';
import { type Page, expect, test as withoutExtension } from '@playwright/test';
import {
  BUILT_EXTENSION,
  PLAYGROUND_ORIGIN,
  addRule,
  mintPairing,
  mintPairingCode,
  mountTheSiteWidget,
  openBareSite,
  openPopup,
  pairFromPopup,
  readNoteIssues,
  readableByThePage,
  recordPageMessages,
  notesOn,
  storedTokens,
  test,
  type StoredToken,
} from './extension.ts';
import { WORKER_ORIGIN } from './pin.ts';
import { AUTHENTICATED_WORKER_ORIGIN, noteWriters } from './worker-sessions.ts';

/**
 * The part of the extension API that a spec calls inside the service worker. The types of the whole
 * API belong to `apps/extension`, and the root does not depend on them.
 */
declare const chrome: {
  storage: {
    local: { get(key: string): Promise<Record<string, unknown>> };
    sync: { get(key: null): Promise<Record<string, unknown>>; set(items: Record<string, unknown>): Promise<void> };
  };
  scripting: { getRegisteredContentScripts(): Promise<{ matches?: string[] }[]> };
};

/**
 * The extension across its worlds (FRU-45): what a site gets with it, without it, and what its page
 * can never read.
 */

const REVIEWER = 'E2E Reviewer';

/** The requests a page sends to either worker, counted from the moment this is called. */
function workerCalls(page: Page): string[] {
  const calls: string[] = [];
  page.on('request', (request) => {
    if ([WORKER_ORIGIN, AUTHENTICATED_WORKER_ORIGIN].some((origin) => request.url().startsWith(origin))) {
      calls.push(request.url());
    }
  });

  return calls;
}

/**
 * Enough time for a registered script to run and a widget to mount and read.
 *
 * An absence has no signal to wait for. The specs that expect a widget on the same page show that it
 * arrives well inside this delay.
 */
async function settle(page: Page): Promise<void> {
  await page.waitForLoadState('load');
  await page.waitForTimeout(1500);
}

async function plantOnTheLatteCard(page: Page, launch: string | RegExp, note: string): Promise<void> {
  await page.getByRole('button', { name: launch }).click();
  await page.locator('[data-testid="card-latte"] .add').click();
  await page.getByPlaceholder('What should change?').fill(note);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
}

/**
 * The licence a store hands out with the extension (FRU-82).
 *
 * `license.test.ts` reads the configuration that asks for the copy; this reads the build that
 * `pnpm e2e` made, which is what the archive is zipped from. A packaging change that drops the file
 * passes the first and fails this one. Raised in review.
 */
withoutExtension('carries its licence into the build a store is given', async () => {
  const built = fs.readFileSync(path.join(BUILT_EXTENSION, 'LICENSE'), 'utf8');

  expect(built).toEqual(fs.readFileSync('apps/extension/LICENSE', 'utf8'));
});

withoutExtension('without the extension, the site holds no widget and calls no worker', async ({ page }) => {
  const calls = workerCalls(page);
  await openBareSite(page, 'ext-absent');
  await settle(page);

  await expect(page.locator('[data-fruitback-host]')).toHaveCount(0);
  await expect(page.locator('[data-fruitback-pin]')).toHaveCount(0);
  expect(calls).toEqual([]);
  expect(await page.evaluate(() => 'fruitbackExtension' in window)).toBe(false);
});

test('an origin with no rule mounts nothing, until a rule covers it', async ({ extension }) => {
  const page = await extension.context.newPage();
  const calls = workerCalls(page);
  await openBareSite(page, 'ext-no-rule');
  await settle(page);

  // The copy holds host access to this origin, so what keeps the page empty is the missing rule.
  await expect(page.locator('[data-fruitback-host]')).toHaveCount(0);
  expect(calls).toEqual([]);
  expect(await page.evaluate(() => '__fruitbackPageScript' in window || 'fruitbackExtension' in window)).toBe(false);

  await addRule(extension, { mode: 'private', clientId: 'playground', endpoint: WORKER_ORIGIN });
  await page.reload();

  await expect(page.getByRole('button', { name: /Leave a note/ })).toBeVisible();
});

test('private mode: the mounted widget reads the component, and the pin comes back', async ({ extension }) => {
  await addRule(extension, { mode: 'private', clientId: 'playground', endpoint: WORKER_ORIGIN });
  const page = await extension.context.newPage();
  await openBareSite(page, 'ext-private');

  await plantOnTheLatteCard(page, /Leave a note/, 'Planté par le mode privé');
  await expect(page.locator('[data-fruitback-pin]')).toHaveCount(1);

  // The component name comes from the React fiber, which only the page's own world can see. A widget
  // mounted from the isolated world would store the note with no source.
  const [note] = await notesOn(page);
  expect(note?.text).toBe('Planté par le mode privé');
  expect(note?.source).toMatchObject({ component: 'Button', file: expect.stringContaining('site.tsx') });

  await page.reload();
  await expect(page.locator('[data-fruitback-pin]')).toHaveCount(1);
});

/**
 * The decision of the isolated world can reach the page twice: once when it starts, and once when the
 * page's world says it is ready. On CI the second one came after the reviewer's click, and the widget
 * was built again under the composer (FRU-186). Here the page posts `ready` itself, which makes the
 * isolated world post the same mount again, at the moment the test picks.
 */
test('private mode: the same decision posted again keeps the open composer and its note', async ({ extension }) => {
  await addRule(extension, { mode: 'private', clientId: 'playground', endpoint: WORKER_ORIGIN });
  const page = await extension.context.newPage();
  await openBareSite(page, 'ext-private-again');

  await page.getByRole('button', { name: /Leave a note/ }).click();
  await page.locator('[data-testid="card-latte"] .add').click();
  const note = page.getByPlaceholder('What should change?');
  await note.fill('Une note à moitié écrite');

  // The page asks, and waits until the isolated world has answered with its mount. Since FRU-397 the
  // bridge hears only the `ready` of its own page script: `hello` makes that script say it again.
  const answered = await page.evaluate(
    () =>
      new Promise<boolean>((resolve) => {
        window.addEventListener('message', (event: MessageEvent) => {
          const data = event.data as { channel?: unknown; kind?: unknown } | null;
          if (data?.channel === 'fruitback-extension/2' && data.kind === 'mount') setTimeout(() => resolve(true), 250);
        });
        window.postMessage({ channel: 'fruitback-extension/2', kind: 'hello' }, '*');
        setTimeout(() => resolve(false), 5_000);
      }),
  );
  expect(answered, 'the isolated world posted its mount again').toBe(true);

  await expect(note).toBeVisible();
  await expect(note).toHaveValue('Une note à moitié écrite');
  await expect(page.getByRole('button', { name: /Leave a note/ })).toHaveCount(1);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.locator('[data-fruitback-pin]')).toHaveCount(1);
});

/**
 * The rules in the account of the browser (FRU-72), on the built extension. This Chromium has no
 * account, so `storage.sync` stays on the machine: what is read here is what the extension writes
 * there and takes from there, not the journey between two browsers.
 */
test('the rules go to the account of the browser only when the reviewer asks, and a rule that arrives has no access', async ({
  extension,
}) => {
  const inAccount = (): Promise<string[]> =>
    extension.worker.evaluate(async () => Object.keys(await chrome.storage.sync.get(null)).sort());
  await addRule(extension, { mode: 'private', clientId: 'playground', endpoint: WORKER_ORIGIN });
  const options = await extension.context.newPage();
  await options.goto(`chrome-extension://${extension.id}/options.html`);
  const box = options.getByLabel('Keep my rules in the account of this browser');

  // Off by default: a rule was added, and nothing left this browser.
  await expect(box).not.toBeChecked();
  expect(await inAccount()).toEqual([]);

  await box.check();
  await expect.poll(inAccount).toEqual([`site:${PLAYGROUND_ORIGIN}`]);

  // A rule of another browser arrives: it is listed, and it runs nowhere until access is granted here.
  await extension.worker.evaluate(async () => {
    await chrome.storage.sync.set({
      'site:https://staging.elsewhere.example': {
        mode: 'private',
        endpoint: 'https://worker.elsewhere.example',
        clientId: 'elsewhere',
        enabled: true,
      },
    });
  });
  // The page of the extension (FRU-301): the row says it, and its panel offers the grant.
  const arrived = options.locator('tr.rule-row[data-pattern="https://staging.elsewhere.example"]');
  await expect(arrived).toContainText('No access');
  await arrived.getByRole('button', { name: /staging\.elsewhere/ }).click();
  const details = options.getByRole('complementary', { name: 'Site details' });
  await expect(details).toContainText('No access in this browser');
  await expect(details.getByRole('button', { name: 'Grant access' })).toBeVisible();
  expect(
    await extension.worker.evaluate(async () =>
      (await chrome.scripting.getRegisteredContentScripts()).flatMap((script) => script.matches ?? []),
    ),
  ).not.toContain('https://staging.elsewhere.example/*');

  // Removed here: removed from the account too.
  await details.getByRole('button', { name: 'Remove rule' }).click();
  await expect.poll(inAccount).toEqual([`site:${PLAYGROUND_ORIGIN}`]);

  // Turned off: the next change stays here.
  await box.uncheck();
  await options.locator(`tr.rule-row[data-pattern="${PLAYGROUND_ORIGIN}"]`).getByRole('button').first().click();
  await options
    .getByRole('complementary', { name: 'Site details' })
    .getByRole('button', { name: 'Remove rule' })
    .click();
  await expect(options.locator('tr.rule-row')).toHaveCount(0);
  expect(await inAccount()).toEqual([`site:${PLAYGROUND_ORIGIN}`]);
});

/**
 * The files of a note (FRU-332). In private mode the reviewer has no session, so the worker takes no
 * file of theirs: the composer shows nothing of files, and the picture of the element of FRU-44,
 * which went to `POST /screenshot`, is no longer offered. A note still goes.
 */
test('private mode: no file and no picture of the element are offered without a session, and the note goes', async ({
  extension,
}) => {
  await addRule(extension, { mode: 'private', clientId: 'playground', endpoint: WORKER_ORIGIN });
  const page = await extension.context.newPage();
  await openBareSite(page, 'ext-capture');

  await page.getByLabel('Open Fruitback settings').click();
  await expect(page.getByRole('dialog', { name: 'Fruitback settings' })).toBeVisible();
  await expect(page.locator('[name="screenshot"]')).toHaveCount(0);
  await page.getByLabel('Open Fruitback settings').click();

  await page.getByRole('button', { name: /Leave a note/ }).click();
  await page.locator('[data-testid="card-latte"] .add').click();
  await expect(page.getByPlaceholder('What should change?')).toBeVisible();
  await expect(page.locator('[data-fruitback-attach]')).toBeHidden();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();

  await plantOnTheLatteCard(page, /Leave a note/, 'Sans fichier, et pourtant envoyée');
  await expect(page.locator('[data-fruitback-pin]')).toHaveCount(1);
  const [note] = await notesOn(page);
  expect(note?.text).toBe('Sans fichier, et pourtant envoyée');
  expect(note && 'screenshot' in note).toBe(false);
});

/**
 * A note of a site of a workspace, with a file of the disk (FRU-332). The worker of the suite keeps its
 * notes in its Linear in memory, which takes files as Linear does: the file goes through the relay to
 * `POST /attachments`, the note names it, and its thread says « 1 attachment » with the link of its
 * ticket. No file is shown on the page.
 */
test('team mode: a note joins a file of the disk, and its thread says how many files it has, with no file shown', async ({
  extension,
}) => {
  await addRule(extension, { mode: 'team', endpoint: WORKER_ORIGIN });
  const page = await extension.context.newPage();
  const calls = workerCalls(page);
  await openBareSite(page, 'ext-attach');
  await mountTheSiteWidget(page, WORKER_ORIGIN);
  await pairFromPopup(extension, page, (await mintPairing(REVIEWER, WORKER_ORIGIN)).code, REVIEWER);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Nos formules' })).toBeVisible();
  await mountTheSiteWidget(page, WORKER_ORIGIN);

  await page.getByRole('button', { name: 'Team feedback' }).click();
  await page.locator('[data-testid="card-latte"] .add').click();
  const files = page.getByRole('group', { name: 'Attachments' });
  await expect(files).toBeVisible();
  // FRU-351: the ways are in the menu of « Attach ».
  await files.getByRole('button', { name: 'Attach' }).click();
  await expect(files.getByRole('menuitem', { name: 'Capture the whole page' })).toBeVisible();
  await expect(files.getByRole('menuitem', { name: 'Capture an area' })).toBeVisible();
  await page.keyboard.press('Escape');
  // The inputs of the disk are opened by their buttons, never shown (the /tfp found them drawn).
  await expect(page.locator('[data-fruitback-attach-file-input]')).toBeHidden();
  await page
    .locator('[data-fruitback-attach-file-input]')
    .setInputFiles({ name: 'log.txt', mimeType: 'text/plain', buffer: Buffer.from('une ligne de log') });
  await expect(page.locator('.fruitback-composer-file')).toHaveAttribute('data-fruitback-file', 'ready');
  await expect(page.locator('.fruitback-composer-file-name')).toHaveText('log.txt');

  await page.getByPlaceholder('What should change?').fill('Avec un fichier');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.locator('[data-fruitback-pin]')).toHaveCount(1);
  await page.getByRole('button', { name: /^Note 1\b/ }).click();
  await expect(page.locator('[data-fruitback-files]')).toHaveText(/^1 attachment · in \S+$/);
  await expect(page.locator('.fruitback-thread img')).toHaveCount(0);

  // Every call went through the background, the file included.
  expect(calls).toEqual([]);
});

/**
 * Asserts that the page can read no stored token, and no bridge message that names the header.
 *
 * Each document records its own messages, so call it before a reload as well as after it.
 */
async function expectNoCredentialReadable(page: Page, tokens: StoredToken[]): Promise<void> {
  const readable = await readableByThePage(page);
  const { messages, chromeStorage } = JSON.parse(readable) as { messages: string[]; chromeStorage: string };
  expect(messages.join('\n')).toContain('relay-response');
  for (const { value } of tokens) expect(readable).not.toContain(value);
  // Only the messages: the widget script on the page names the header in its own code.
  expect(messages.join('\n')).not.toMatch(/authorization/i);
  expect(chromeStorage).toBe('undefined');
}

// The site of the worker on 8789 is « Members only », the default of a site (FRU-330). A spec that
// sets « Anyone on the page » gives the default back, whatever it ended on.
test.afterEach(async () => {
  await noteWriters('members');
});

test('private mode on a worker that wants a session: the popup says why the page shows no note (FRU-66)', async ({
  extension,
}) => {
  // A site read by its members that takes a note from anybody: said here, not read from the default
  // of the worker, which is « Members only » since FRU-330.
  await noteWriters('anyone');
  try {
    await addRule(extension, { mode: 'private', clientId: 'playground', endpoint: AUTHENTICATED_WORKER_ORIGIN });
    const page = await extension.context.newPage();
    await openBareSite(page, 'ext-private-authenticated');
    // The widget mounts and looks ready. Its reads answer 401, and nothing on the page says so.
    await expect(page.getByRole('button', { name: /Leave a note/ })).toBeVisible();

    const popup = await openPopup(extension, page);

    await expect(popup.getByText(/answers a signed-in reader only/)).toBeVisible();
    await expect(popup.getByText(/takes notes from its members only/)).toHaveCount(0);
    // A session changes nothing in this mode, so the popup offers none (FRU-88). The team spec below
    // pairs through the same field, which is the control for this absence.
    await expect(popup.getByLabel('Connection code')).toHaveCount(0);
    await expect(popup.getByText(/Not paired/)).toHaveCount(0);
    const shot = test.info().outputPath('popup.png');
    await popup.screenshot({ path: shot });
    await test.info().attach('popup', { path: shot, contentType: 'image/png' });
    await expect(popup.getByRole('link', { name: 'Which mode can read it' })).toHaveAttribute(
      'href',
      'https://sakuga-software.github.io/fruitback/modes.html',
    );
  } finally {
    await noteWriters('members');
  }
});

test('private mode on a site whose notes are « Members only »: the widget offers no note, and the popup says why (FRU-330)', async ({
  extension,
}) => {
  // Said, not read from the default: the spec above is its control, on the same worker and site.
  await noteWriters('members');
  await addRule(extension, { mode: 'private', clientId: 'playground', endpoint: AUTHENTICATED_WORKER_ORIGIN });
  const page = await extension.context.newPage();
  await openBareSite(page, 'ext-private-members-only');
  const closed = page.getByRole('button', { name: 'Notes from members only' });
  await expect(closed).toBeVisible();
  await expect(closed).toHaveAttribute('aria-disabled', 'true');
  await expect(page.getByRole('button', { name: /Leave a note/ })).toHaveCount(0);

  const popup = await openPopup(extension, page);

  await expect(
    popup.getByText(/takes notes from its members only, and in private mode the extension holds no session/),
  ).toBeVisible();
  await expect(popup.getByText(/answers a signed-in reader only/)).toHaveCount(0);
  await expect(popup.getByRole('link', { name: 'Which mode can read it' })).toBeVisible();
});

test('private mode on a worker that answers anyone: the popup says nothing about a session', async ({ extension }) => {
  // The control for the spec above: the same rule, on the worker that reads `public`.
  await addRule(extension, { mode: 'private', clientId: 'playground', endpoint: WORKER_ORIGIN });
  const page = await extension.context.newPage();
  await openBareSite(page, 'ext-private-public');

  const popup = await openPopup(extension, page);
  // An absence proves nothing until the question was asked and answered, so wait for the answer.
  await page.bringToFront();
  const answered = popup.waitForResponse((response) => response.url().startsWith(`${WORKER_ORIGIN}/feedback?`));
  await popup.reload();
  expect((await answered).status()).toBe(200);
  await popup.evaluate(() => new Promise((resolve) => setTimeout(resolve, 0)));

  await expect(popup.getByText(/answers a signed-in reader only/)).toHaveCount(0);
  await expect(popup.getByText(/takes notes from its members only/)).toHaveCount(0);
  await expect(popup.getByText('On · playground', { exact: false })).toBeVisible();
  // The control of the closed button above: a site that everyone reads offers a note.
  await expect(page.getByRole('button', { name: /Leave a note/ })).toBeVisible();
});

test('team mode: paired from the popup, the site reads and writes through the relay and never sees a token', async ({
  extension,
}) => {
  await recordPageMessages(extension.context);
  await addRule(extension, { mode: 'team', endpoint: AUTHENTICATED_WORKER_ORIGIN });
  const page = await extension.context.newPage();
  const calls = workerCalls(page);
  await openBareSite(page, 'ext-team');
  await mountTheSiteWidget(page, AUTHENTICATED_WORKER_ORIGIN);
  await expect(page.getByRole('button', { name: 'Team feedback' })).toBeVisible();

  // The control of the absence below: before the pairing nobody names this reviewer, and the
  // composer asks (FRU-112).
  // The name of the person, a field in sight since FRU-305, that a known reviewer no longer sees.
  const nameField = page.locator('[data-fruitback-who]');
  await page.getByRole('button', { name: 'Team feedback' }).click();
  await page.locator('[data-testid="card-latte"] .add').click();
  await expect(nameField).toBeVisible();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();

  await pairFromPopup(extension, page, await mintPairingCode(REVIEWER), REVIEWER);

  // The page is not told of a pairing, so its widget learns it at its next read: the send below
  // makes one.
  await plantOnTheLatteCard(page, 'Team feedback', 'Planté par le mode équipe');
  await expect(page.locator('[data-fruitback-pin]')).toHaveCount(1);

  const tokens = await storedTokens(extension.worker);
  // The refresh token in `local` and the access token in `session`, or the searches below prove nothing.
  expect([...new Set(tokens.map((token) => token.area))].sort()).toEqual(['local', 'session']);
  await expectNoCredentialReadable(page, tokens);

  // This worker refuses a read with no identity, so the pin read back below came through the relay.
  expect((await readNoteIssues(page, AUTHENTICATED_WORKER_ORIGIN)).status).toBe(401);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Nos formules' })).toBeVisible();
  await mountTheSiteWidget(page, AUTHENTICATED_WORKER_ORIGIN);
  await expect(page.locator('[data-fruitback-pin]')).toHaveCount(1);
  await expectNoCredentialReadable(page, tokens);

  // Paired, and read through the relay: the session names the reviewer, the worker says so on the
  // read, and a name typed here would be replaced with no word. The composer does not ask (FRU-112).
  await page.getByRole('button', { name: 'Team feedback' }).click();
  await page.locator('[data-testid="card-latte"] .add').click();
  await expect(page.getByPlaceholder('What should change?')).toBeVisible();
  await expect(nameField).toBeHidden();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();

  // Every call went through the background. The page itself never called a worker.
  expect(calls).toEqual([]);

  // Signed by the worker from the session: only the relay carries it.
  const access = tokens.find((token) => token.area === 'session')?.value;
  const [note] = await notesOn(page, AUTHENTICATED_WORKER_ORIGIN, access);
  expect(note?.reporter).toMatchObject({ name: REVIEWER, verified: true });
});

test('a session held with the worker of a private-mode site stays on the popup, with its log out (FRU-88)', async ({
  extension,
}) => {
  await addRule(extension, { mode: 'team', endpoint: AUTHENTICATED_WORKER_ORIGIN });
  const page = await extension.context.newPage();
  await openBareSite(page, 'ext-private-held-session');
  await pairFromPopup(extension, page, await mintPairingCode(REVIEWER), REVIEWER);

  // The same rule, moved to private mode from the popup. The session stays in storage.
  const popup = await openPopup(extension, page);
  await popup.getByRole('button', { name: 'Change' }).click();
  await popup.getByLabel(/^Mode/).selectOption('private');
  await popup.getByLabel('Client id', { exact: true }).fill('playground');
  await popup.getByRole('button', { name: 'Save' }).click();

  await expect(popup.getByText('On · playground', { exact: false })).toBeVisible();
  await expect(popup.getByText(`Connected as ${REVIEWER}`)).toBeVisible();
  await expect(popup.getByLabel('Connection code')).toHaveCount(0);

  await popup.getByRole('button', { name: 'Sign out' }).click();
  await expect(popup.getByText(`Connected as ${REVIEWER}`)).toHaveCount(0);
  await expect(popup.getByLabel('Connection code')).toHaveCount(0);
  await expect(popup.getByText('On · playground', { exact: false })).toBeVisible();
});

test('a failed pairing offers the one thing to do about it, and Try again pairs with the same code (FRU-90)', async ({
  extension,
}) => {
  await addRule(extension, { mode: 'team', endpoint: AUTHENTICATED_WORKER_ORIGIN });
  const page = await extension.context.newPage();
  await openBareSite(page, 'ext-remedies');
  const popup = await openPopup(extension, page);
  const shot = async (name: string): Promise<void> => {
    const path = test.info().outputPath(`${name}.png`);
    await popup.screenshot({ path, clip: { x: 0, y: 0, width: 520, height: 330 } });
    await test.info().attach(name, { path, contentType: 'image/png' });
  };

  // A code nobody minted: the worker answers, so the popup must not offer to try it again.
  await popup.getByRole('button', { name: 'I have a code' }).click();
  await popup.getByLabel('Connection code').fill('AAAA-BBBB-CCCC');
  await popup.getByRole('button', { name: 'Connect to this server' }).click();
  await expect(popup.getByText('That code has been used or has expired. Ask for a new one.')).toBeVisible();
  await expect(popup.getByRole('link', { name: 'How to get a code' })).toHaveAttribute(
    'href',
    'https://sakuga-software.github.io/fruitback/reviewing.html#3-pair-in-team-mode',
  );
  await expect(popup.getByRole('button', { name: 'Try again' })).toHaveCount(0);
  await shot('code-spent');

  // A worker that does not answer once. The code is not spent, so the same one must pair after.
  let refused = 0;
  await popup.route(`${AUTHENTICATED_WORKER_ORIGIN}/session/pair`, async (route) => {
    if (refused++ === 0) await route.abort('connectionrefused');
    else await route.continue();
  });
  await popup.getByLabel('Connection code').fill(await mintPairingCode(REVIEWER));
  await popup.getByRole('button', { name: 'Connect to this server' }).click();
  await expect(popup.getByText('The server did not answer. Try again.')).toBeVisible();
  await shot('worker-down');

  await popup.getByRole('button', { name: 'Try again' }).click();
  await expect(popup.getByText(`Connected as ${REVIEWER}`)).toBeVisible();
  expect(refused, 'the first attempt did not reach the route, so nothing was retried').toBe(2);
});

test('a pairing link pairs with one click, and the site then works through that session (FRU-92)', async ({
  extension,
}) => {
  await addRule(extension, { mode: 'team', endpoint: AUTHENTICATED_WORKER_ORIGIN });
  const site = await extension.context.newPage();
  await openBareSite(site, 'ext-pair-link');
  await mountTheSiteWidget(site, AUTHENTICATED_WORKER_ORIGIN);

  // The link an operator sends, opened like any link.
  const { link, code } = await mintPairing(REVIEWER);
  expect(link).toBe(`${AUTHENTICATED_WORKER_ORIGIN}/pair#${code}`);
  const linkPage = await extension.context.newPage();
  const requests: string[] = [];
  linkPage.on('request', (request) => requests.push(request.url()));
  await linkPage.goto(link);
  await expect(linkPage.getByRole('heading', { name: 'Pair the Fruitback extension' })).toBeVisible();
  // The worker was asked for the page, and the code was in no request: a fragment is not sent.
  expect(requests.length).toBeGreaterThan(0);
  expect(requests.join('\n')).not.toContain(code);

  const popup = await openPopup(extension, linkPage, AUTHENTICATED_WORKER_ORIGIN);
  await expect(popup.getByText(`This page is a connection link for ${AUTHENTICATED_WORKER_ORIGIN}.`)).toBeVisible();
  // No field to fill in, and no form to switch the worker's own page on as a site.
  await expect(popup.getByLabel('Connection code')).toHaveCount(0);
  await expect(popup.getByRole('button', { name: 'Turn on for this site' })).toHaveCount(0);
  // The address has the shape of a link, and that proves nothing: the site's screen is one click away.
  await popup.getByRole('button', { name: 'This is a site to review' }).click();
  await expect(popup.getByRole('button', { name: 'Turn on for this site' })).toBeVisible();
  await popup.reload();
  await expect(popup.getByText(`This page is a connection link for ${AUTHENTICATED_WORKER_ORIGIN}.`)).toBeVisible();
  const shot = test.info().outputPath('pair-link.png');
  await popup.screenshot({ path: shot, clip: { x: 0, y: 0, width: 520, height: 220 } });
  await test.info().attach('pair-link', { path: shot, contentType: 'image/png' });
  const pageShot = test.info().outputPath('pair-page.png');
  await linkPage.screenshot({ path: pageShot, clip: { x: 0, y: 0, width: 900, height: 360 } });
  await test.info().attach('pair-page', { path: pageShot, contentType: 'image/png' });

  await popup.getByRole('button', { name: 'Connect to this server' }).click();
  await expect(popup.getByText(`Connected as ${REVIEWER}`)).toBeVisible();

  // The session is stored under the endpoint the rule names, so the site's widget is served.
  await plantOnTheLatteCard(site, 'Team feedback', 'Planté après un lien');
  await expect(site.locator('[data-fruitback-pin]')).toHaveCount(1);

  // The same link a second time: the code is spent, and the popup says what to do next.
  await popup.getByRole('button', { name: 'Sign out' }).click();
  await popup.getByRole('button', { name: 'Connect to this server' }).click();
  await expect(popup.getByText('That code has been used or has expired. Ask for a new one.')).toBeVisible();
  await expect(popup.getByRole('link', { name: 'How to get a code' })).toBeVisible();
});

test('the popup, the options page and the mounted widget speak the language of the account (FRU-131)', async ({
  extension,
}) => {
  // Private mode on this site offers a note when anybody may leave one (FRU-330): said here.
  await noteWriters('anyone');
  await addRule(extension, { mode: 'team', endpoint: AUTHENTICATED_WORKER_ORIGIN });
  const page = await extension.context.newPage();
  await openBareSite(page, 'ext-language');
  // The control: English, in the popup and then on the page.
  await pairFromPopup(extension, page, await mintPairingCode(REVIEWER), REVIEWER);
  const setUp = await openPopup(extension, page);
  await setUp.getByRole('button', { name: 'Change' }).click();
  await setUp.getByLabel(/^Mode/).selectOption('private');
  await setUp.getByLabel('Client id', { exact: true }).fill('playground');
  await setUp.getByRole('button', { name: 'Save' }).click();
  await expect(setUp.getByText('On · playground', { exact: false })).toBeVisible();
  await setUp.close();
  await expect(page.getByRole('button', { name: 'Leave a note' })).toBeVisible();

  // The worker of the session says the account reads French. The E2E workers keep no accounts, so
  // the answer of that one route is given here; the popup asks it with its real session.
  const asked: (string | undefined)[] = [];
  await extension.context.route(`${AUTHENTICATED_WORKER_ORIGIN}/session/sites`, (route) => {
    asked.push(route.request().headers().authorization);

    return route.fulfill({ json: { workspace: { id: 'ws_1', name: 'Acme' }, sites: [], locale: 'fr' } });
  });
  // This popup opens in English, learns the language, and draws its screen again in French
  // (FRU-319): the first popup after a change in the console spoke the language of before.
  const learner = await openPopup(extension, page);
  await expect
    .poll(() => extension.worker.evaluate(() => chrome.storage.local.get('language')))
    .toEqual({ language: 'fr' });
  expect(asked[0]).toMatch(/^Bearer .+/);
  await expect(learner.getByText(`Connecté en tant que ${REVIEWER}`)).toBeVisible();
  expect(await learner.evaluate(() => document.documentElement.lang)).toBe('fr');
  await learner.close();

  // The open tab gets the widget again, in French, with no reload.
  await expect(page.getByRole('button', { name: 'Laisser une note' })).toBeVisible();

  const popup = await openPopup(extension, page);
  await expect(popup.getByText(`Connecté en tant que ${REVIEWER}`)).toBeVisible();
  await expect(popup.getByText('Activé · playground', { exact: false })).toBeVisible();
  await expect(popup.getByRole('button', { name: 'Compte et réglages' })).toBeVisible();
  expect(await popup.evaluate(() => document.documentElement.lang)).toBe('fr');

  const options = await extension.context.newPage();
  await options.goto(`chrome-extension://${extension.id}/options.html`);
  await expect(options.getByRole('heading', { level: 1, name: 'Sites' })).toBeVisible();
  await expect(options.getByRole('button', { name: 'Ajouter un site' })).toBeVisible();
  await options.close();

  // Logged out, no account is left to speak for: the language goes at once, and the open tab is
  // English again with no reload.
  await popup.getByRole('button', { name: 'Se déconnecter' }).click();
  await expect.poll(() => extension.worker.evaluate(() => chrome.storage.local.get('language'))).toEqual({});
  await expect(page.getByRole('button', { name: 'Leave a note' })).toBeVisible();
  await popup.close();
  const after = await openPopup(extension, page);
  await expect(after.getByText('On · playground', { exact: false })).toBeVisible();
});
