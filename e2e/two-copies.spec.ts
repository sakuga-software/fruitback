import path from 'node:path';
import { type Page, expect } from '@playwright/test';
import { type LoadedExtension, mintPairing, openPopup, test } from './extension.ts';
import { caseOf, hydrated } from './pin.ts';
import { AUTHENTICATED_WORKER_ORIGIN } from './worker-sessions.ts';

/**
 * Two copies of Fruitback in one browser (FRU-397).
 *
 * Measured on 2026-10-23 on the Chrome of Mathieu: the 0.3.0 of the store, and a 0.1.0 unpacked
 * beside it. The page script of the 0.1.0 held the page, obeyed the bridge of the 0.3.0, took its site
 * of a workspace for a private one, and read it from the page with no session: `401`.
 *
 * The old copy is `e2e/fixtures/old-copy`: the guard and the channel of 0.1.0, built for this spec.
 * It starts before the current copy, or after it (`?old-late`). Both orders: no request of the page
 * for the site of the workspace, and the popup asks to remove the other copy.
 */

const OLD_COPY = path.resolve('e2e/fixtures/old-copy');
const NAME = 'Camille Durand';

test.use({ alongside: [OLD_COPY] });

/** A session of the workspace of the suite's second worker, through a pairing link. */
async function paired(extension: LoadedExtension): Promise<void> {
  const { link } = await mintPairing(NAME);
  const worker = await extension.context.newPage();
  await worker.goto(link);
  const popup = await openPopup(extension, worker, AUTHENTICATED_WORKER_ORIGIN);
  await popup.getByRole('button', { name: 'Pair with this worker' }).click();
  await expect(popup.getByText(NAME, { exact: false })).toBeVisible();
  await popup.close();
  await worker.close();
}

/** Every request the page itself sends to the worker of the workspace. The relay's are not the page's. */
function pageReads(page: Page): string[] {
  const seen: string[] = [];
  page.on('request', (request) => {
    if (request.url().startsWith(`${AUTHENTICATED_WORKER_ORIGIN}/`)) seen.push(request.url());
  });

  return seen;
}

const WARNING =
  'Another copy of Fruitback runs on this page, or the version of before of this one. Reload the page. If this stays, remove the other copy in chrome://extensions.';

for (const order of ['before', 'after'] as const) {
  test(`an old copy that starts ${order} the current one reads nothing for the site of the workspace, and the popup says to remove it`, async ({
    extension,
  }) => {
    await paired(extension);
    const page = await extension.context.newPage();
    const direct = pageReads(page);
    await page.goto(`/?case=${caseOf(`two-copies-${order}`)}&widget=off${order === 'after' ? '&old-late=1' : ''}`);
    await expect(page.getByRole('heading', { name: 'Nos formules' })).toBeVisible();
    await hydrated(page);

    let popup = await openPopup(extension, page);
    await popup.getByRole('button', { name: 'Turn on' }).click();
    await expect(popup.getByRole('switch', { name: 'Fruitback on localhost:5177' })).toBeChecked();

    // The tab says it once both scripts of the current copy run in it: asked again until then.
    await expect
      .poll(
        async () => {
          await popup.close();
          popup = await openPopup(extension, page);

          return popup
            .getByText(WARNING)
            .count()
            .catch(() => 0);
        },
        { timeout: 20_000, intervals: [1_000] },
      )
      .toBe(1);
    const shot = test.info().outputPath(`popup-${order}.png`);
    await popup.screenshot({ path: shot });
    await test.info().attach(`popup, old copy ${order}`, { path: shot, contentType: 'image/png' });

    if (order === 'after') {
      // The current copy holds the page: its widget, one, through the relay.
      await expect(page.getByRole('button', { name: 'Leave feedback' })).toHaveCount(1);
    } else {
      // The old copy holds the page: the current one steps aside, and mounts nothing beside it.
      await expect(page.getByRole('button', { name: 'Leave feedback' })).toHaveCount(0);
    }
    // A reload: both copies start again, in the same order.
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Nos formules' })).toBeVisible();
    await hydrated(page);
    if (order === 'after') await expect(page.getByRole('button', { name: 'Leave feedback' })).toHaveCount(1);
    // Nothing on the page read the site of the workspace with no session.
    expect(direct).toEqual([]);
  });
}
