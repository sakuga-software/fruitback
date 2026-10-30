import { expect } from '@playwright/test';
import { PLAYGROUND_ORIGIN, openBareSite, openPopup, test } from './extension.ts';
import { WORKER_ORIGIN } from './pin.ts';

/**
 * A rule whose worker is not at its address (FRU-395). Measured in production on 2026-10-23: a rule
 * of private mode kept `https://api.fruitback.com/pair` as its worker, a pairing link pasted in the
 * wrong field, and each page read `/pair/feedback`, which answered `404`, with nothing on screen.
 *
 * The form refuses that address now (`site-form.test.ts`), so the rule is written as an older
 * version stored it, straight into the storage of the extension.
 */

/** The one `chrome.*` call of this spec, from the service worker. */
declare const chrome: { storage: { local: { set(items: Record<string, unknown>): Promise<void> } } };

const SENTENCE = 'The server of this rule does not answer. Check its address in the options.';

for (const [name, endpoint, said] of [
  ['…/pair', `${WORKER_ORIGIN}/pair`, 1],
  // The control: the same rule at the address of the worker says nothing.
  ['the worker', WORKER_ORIGIN, 0],
] as const) {
  test(`a stored rule whose worker is ${name}: the popup ${said === 1 ? 'says it' : 'says nothing'}`, async ({
    extension,
  }) => {
    await extension.worker.evaluate(
      async ([origin, worker]: readonly [string, string]) => {
        await chrome.storage.local.set({
          sites: { [origin]: { mode: 'private', endpoint: worker, clientId: 'playground', enabled: true } },
        });
      },
      [PLAYGROUND_ORIGIN, endpoint] as const,
    );
    const page = await extension.context.newPage();
    await openBareSite(page, `rule-address-${said}`);
    const popup = await openPopup(extension, page);

    await expect(popup.getByText(`Rule: ${PLAYGROUND_ORIGIN}`)).toBeVisible();
    if (said === 1) await expect(popup.getByText(SENTENCE)).toBeVisible();
    else {
      // The probe answers within a moment: waited for on the worker's read, then nothing said.
      await popup.waitForTimeout(1_500);
      await expect(popup.getByText(SENTENCE)).toHaveCount(0);
    }
  });
}

test('the page of the extension refuses a pairing link as a worker, and « Connect with this link » opens its card with the code (review of #539)', async ({
  extension,
}) => {
  const options = await extension.context.newPage();
  await options.goto(`chrome-extension://${extension.id}/options.html`);
  await options.getByRole('button', { name: 'Add a site' }).click();
  await options.getByLabel('Sites', { exact: true }).fill(PLAYGROUND_ORIGIN);
  await options.getByLabel(/^Mode/).selectOption('private');
  await options.getByLabel('Server address', { exact: true }).fill(`${WORKER_ORIGIN}/pair#ABCD-EFGH-JKLM`);
  await options.getByLabel('Client id', { exact: true }).fill('playground');
  await options.getByRole('button', { name: 'Add rule' }).click();

  await expect(
    options.getByText(
      'This is a connection link, not the address of a server. Use it to connect, and give the rule the address before /pair.',
    ),
  ).toBeVisible();
  // Nothing was stored.
  await expect(options.locator(`tr.rule-row[data-pattern="${PLAYGROUND_ORIGIN}"]`)).toHaveCount(0);

  await options.getByRole('button', { name: 'Connect with this link' }).click();
  const card = options.locator(`.worker-card[data-endpoint="${WORKER_ORIGIN}"]`);
  await expect(card.getByLabel('Connection code')).toHaveValue('ABCD-EFGH-JKLM');
});
