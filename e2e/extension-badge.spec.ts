import { expect } from '@playwright/test';
import { type LoadedExtension, PLAYGROUND_ORIGIN, openBareSite, openPopup, sessionSitesOf, test } from './extension.ts';
import { paired } from './side-panel.ts';
import { AUTHENTICATED_WORKER_ORIGIN } from './worker-sessions.ts';

/**
 * The badge on the icon (FRU-604): the notes of the reviewer that the team marked done and that they
 * did not confirm, for the site of the tab, in the blue of done, and on that tab only.
 *
 * The worker of the suite answers `toCheck` to the session of an account, and the pairing of this
 * spec is not one: the count is added to its real answer of `GET /session/sites`, which the
 * background asks with its own session.
 */

/** The `chrome.*` calls of this spec, from the service worker. */
declare const chrome: {
  tabs: { query(filter: object): Promise<{ id?: number; url?: string }[]> };
  action: {
    getBadgeText(details: { tabId: number }): Promise<string>;
    getBadgeBackgroundColor(details: { tabId: number }): Promise<number[]>;
  };
};

/** The badge of the tab whose address starts with `start`, as the browser holds it. */
function badgeOf(extension: LoadedExtension, start: string): Promise<{ text: string; color: number[] } | null> {
  return extension.worker.evaluate(async (start) => {
    const tab = (await chrome.tabs.query({})).find((each) => each.url?.startsWith(start));
    if (tab?.id === undefined) return null;

    return {
      text: await chrome.action.getBadgeText({ tabId: tab.id }),
      color: await chrome.action.getBadgeBackgroundColor({ tabId: tab.id }),
    };
  }, start);
}

test('the icon shows the notes to check of the site of the tab, in the blue of done, on that tab only', async ({
  extension,
}) => {
  test.slow();
  let toCheck = 2;
  const asked: string[] = [];
  await extension.context.route(sessionSitesOf(AUTHENTICATED_WORKER_ORIGIN), async (route) => {
    asked.push(route.request().url());
    const response = await route.fetch();
    const body = (await response.json()) as { sites?: { origin: string; toCheck?: number }[] };
    for (const site of body.sites ?? []) if (site.origin === PLAYGROUND_ORIGIN) site.toCheck = toCheck;

    return route.fulfill({ response, json: body });
  });
  await paired(extension);
  const page = await extension.context.newPage();
  await openBareSite(page, 'extension-badge');
  const popup = await openPopup(extension, page);
  await popup.getByRole('button', { name: /^(Turn on|Activer)$/ }).click();
  await expect(page.locator('[data-fruitback-host-launch]')).toBeVisible();
  await popup.close();
  await page.bringToFront();

  await expect.poll(async () => (await badgeOf(extension, PLAYGROUND_ORIGIN))?.text, { timeout: 20_000 }).toBe('2');
  // `#5560c4`, `--stage-done` of the popup.
  expect((await badgeOf(extension, PLAYGROUND_ORIGIN))?.color).toEqual([85, 96, 196, 255]);
  expect(asked.some((url) => new URL(url).searchParams.get('origin') === PLAYGROUND_ORIGIN)).toBe(true);

  // A tab of another site says nothing, and the tab of the site keeps its count.
  const other = await extension.context.newPage();
  await other.goto(`${AUTHENTICATED_WORKER_ORIGIN}/health`);
  await expect.poll(async () => (await badgeOf(extension, AUTHENTICATED_WORKER_ORIGIN))?.text).toBe('');
  expect((await badgeOf(extension, PLAYGROUND_ORIGIN))?.text).toBe('2');

  // Every note checked: the next load of the page empties the badge, and never says « 0 ».
  toCheck = 0;
  await page.bringToFront();
  await page.reload();
  await expect.poll(async () => (await badgeOf(extension, PLAYGROUND_ORIGIN))?.text, { timeout: 20_000 }).toBe('');
});
