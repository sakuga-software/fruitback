import { expect, type Page } from '@playwright/test';
import {
  PLAYGROUND_ORIGIN,
  type LoadedExtension,
  mintPairingCode,
  notesOn,
  readNoteIssues,
  storedTokens,
  test,
} from '../extension.ts';
import { WORKER_ORIGIN } from '../pin.ts';
import { AUTHENTICATED_WORKER_ORIGIN } from '../worker-sessions.ts';
import {
  NO_NETWORK_BUT_LOCALHOST,
  PUBLISHED_EXTENSION,
  PUBLISHED_IIFE,
  openBareSite,
  plantOnTheLatteCard,
  publishedVersions,
} from './published.ts';

/**
 * The last released extension against the workers of this commit (FRU-460).
 *
 * The archive is the one that the stores were given. The copy gets host access to the local
 * origins, as in `extension.ts`, and nothing else changes. Its two modes that talk to a worker:
 * private (the extension mounts its own widget) and team (the site mounts the published widget, the
 * extension pairs and relays).
 */
test.use({ build: PUBLISHED_EXTENSION, browserArgs: [NO_NETWORK_BUT_LOCALHOST] });

const VERSION = publishedVersions().extension;
const REVIEWER = 'E2E Published';

/** A rule for the playground, from the options page of the published extension. */
async function addRule(
  extension: LoadedExtension,
  rule: { endpoint: string } & ({ mode: 'private'; clientId: string } | { mode: 'team' }),
): Promise<void> {
  const options = await extension.context.newPage();
  await options.goto(`chrome-extension://${extension.id}/options.html`);
  await options.getByRole('button', { name: 'Add a site' }).click();
  await options.getByLabel('Sites', { exact: true }).fill(PLAYGROUND_ORIGIN);
  await options.getByLabel(/^Mode/).selectOption(rule.mode);
  await options.getByLabel('Worker endpoint', { exact: true }).fill(rule.endpoint);
  if (rule.mode === 'private') await options.getByLabel('Client id', { exact: true }).fill(rule.clientId);
  await options.getByRole('button', { name: 'Add rule' }).click();
  await expect(options.locator(`tr.rule-row[data-pattern="${PLAYGROUND_ORIGIN}"]`)).toContainText('Granted');
  await options.close();
}

/** Pair from the popup of the published extension, for the site in `site`. */
async function pairFromPopup(extension: LoadedExtension, site: Page, code: string): Promise<void> {
  await site.bringToFront();
  const url = `chrome-extension://${extension.id}/popup.html`;
  await extension.worker.evaluate(async (popupUrl) => {
    await (
      globalThis as unknown as { chrome: { tabs: { create(p: { url: string; active: boolean }): Promise<unknown> } } }
    ).chrome.tabs.create({ url: popupUrl, active: false });
  }, url);
  let popup: Page | undefined;
  await expect.poll(() => (popup = extension.context.pages().find((page) => page.url() === url))).toBeDefined();
  if (popup === undefined) throw new Error('the popup did not open');

  await popup.getByRole('button', { name: 'I have a code' }).click();
  await popup.getByLabel('Pairing code').fill(code);
  await popup.getByRole('button', { name: 'Pair with this worker' }).click();
  await expect(popup.getByText(`Paired as ${REVIEWER}`)).toBeVisible();
  await popup.close();
}

/** The site of team mode: the published widget, dormant until the extension announces itself. */
async function mountTheSiteWidget(page: Page): Promise<void> {
  await page.addScriptTag({ path: PUBLISHED_IIFE });
  await page.evaluate((endpoint) => {
    type Mounted = { destroy(): void };
    const scope = globalThis as unknown as {
      Fruitback: { init(options: Record<string, unknown>): Mounted };
      fruitbackExtension?: { transport: unknown };
    };
    let widget: Mounted | undefined;
    const follow = (): void => {
      widget?.destroy();
      widget = undefined;
      if (scope.fruitbackExtension === undefined) return;
      widget = scope.Fruitback.init({
        endpoint,
        clientId: 'playground',
        label: 'Team feedback',
        transport: scope.fruitbackExtension.transport,
      });
    };
    window.addEventListener('fruitback:extension', follow);
    follow();
  }, AUTHENTICATED_WORKER_ORIGIN);
}

test(`extension ${VERSION}, private mode: the note goes to this worker and comes back`, async ({ extension }) => {
  await addRule(extension, { mode: 'private', clientId: 'playground', endpoint: WORKER_ORIGIN });
  const page = await extension.context.newPage();
  // The background registers the scripts of the origin after the rule is stored: poll by reloading.
  await expect(async () => {
    await openBareSite(page, 'published-ext-private');
    await expect(page.getByRole('button', { name: /Leave feedback/ })).toBeVisible({ timeout: 2_000 });
  }).toPass();

  await plantOnTheLatteCard(page, /Leave feedback/, 'Publiée, mode privé');
  const [note] = await notesOn(page);
  expect(note?.text).toBe('Publiée, mode privé');

  await page.reload();
  await expect(page.locator('[data-fruitback-pin]')).toHaveCount(1);
});

test(`extension ${VERSION}, team mode: paired with a code, the note goes through the relay`, async ({ extension }) => {
  await addRule(extension, { mode: 'team', endpoint: AUTHENTICATED_WORKER_ORIGIN });
  const page = await extension.context.newPage();
  await openBareSite(page, 'published-ext-team');
  await mountTheSiteWidget(page);
  await expect(page.getByRole('button', { name: 'Team feedback' })).toBeVisible();

  await pairFromPopup(extension, page, await mintPairingCode(REVIEWER));
  await page.bringToFront();
  await plantOnTheLatteCard(page, 'Team feedback', 'Publiée, mode équipe');

  // This worker refuses a read with no identity: the pin read back below came through the relay.
  expect((await readNoteIssues(page, AUTHENTICATED_WORKER_ORIGIN)).status).toBe(401);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Nos formules' })).toBeVisible();
  await mountTheSiteWidget(page);
  await expect(page.locator('[data-fruitback-pin]')).toHaveCount(1);

  // The worker signed the note from the session that the published extension holds.
  const access = (await storedTokens(extension.worker)).find((token) => token.area === 'session')?.value;
  const [note] = await notesOn(page, AUTHENTICATED_WORKER_ORIGIN, access);
  expect(note).toMatchObject({ text: 'Publiée, mode équipe', reporter: { name: REVIEWER, verified: true } });
});
