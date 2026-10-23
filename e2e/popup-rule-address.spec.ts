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

const SENTENCE = 'The worker of this rule does not answer. Check its address in the options.';

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
