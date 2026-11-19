import { expect } from '@playwright/test';
import { PLAYGROUND_ORIGIN, test } from './extension.ts';
import { WORKER_ORIGIN } from './pin.ts';
import { AUTHENTICATED_WORKER_ORIGIN } from './worker-sessions.ts';

/**
 * FRU-643: no new private-mode rule on the Fruitback of the build. The suite builds the extension
 * with the second worker as its Cloud (`WXT_FRUITBACK_CLOUD`). A worker of somebody else is the
 * control: the same form stores the rule.
 */

const REFUSED =
  'Fruitback Cloud shows notes to a signed-in reviewer only, so private mode does not run on it. Sign in to Fruitback, then turn the site on from the popup.';

for (const [name, endpoint, refused] of [
  ['the Cloud of the build', `${AUTHENTICATED_WORKER_ORIGIN}/`, true],
  ['a server of somebody else', WORKER_ORIGIN, false],
] as const) {
  test(`the page of the extension ${refused ? 'refuses' : 'stores'} a private-mode rule on ${name}`, async ({
    extension,
  }) => {
    const options = await extension.context.newPage();
    await options.goto(`chrome-extension://${extension.id}/options.html`);
    await options.getByRole('button', { name: 'Add a site' }).click();
    await options.getByLabel('Sites', { exact: true }).fill(PLAYGROUND_ORIGIN);
    await options.getByLabel(/^Mode/).selectOption('private');
    await options.getByLabel('Server address', { exact: true }).fill(endpoint);
    await options.getByLabel('Client id', { exact: true }).fill('playground');
    await options.getByRole('button', { name: 'Add rule' }).click();

    const row = options.locator(`tr.rule-row[data-pattern="${PLAYGROUND_ORIGIN}"]`);
    if (refused) {
      await expect(options.getByText(REFUSED)).toBeVisible();
      await expect(row).toHaveCount(0);
    } else {
      await expect(row).toHaveCount(1);
      await expect(options.getByText(REFUSED)).toHaveCount(0);
    }
  });
}
