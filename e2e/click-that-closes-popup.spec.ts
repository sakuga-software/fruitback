import { type Locator, type Page, test as base, expect } from '@playwright/test';
import { clickThatClosesPopup, openBareSite, openPopup, test } from './extension.ts';

/**
 * `clickThatClosesPopup` of `extension.ts` (FRU-375): the « closed » error of a click is the end it
 * waits for only when the popup is closed, and every other error is thrown.
 *
 * The first cases need no browser: a page and a locator that answer what each case needs. The last
 * one is the popup of the real extension, which closes itself while `click()` is in progress. With a
 * plain `click()`, that case fails with the error of CI (measured: 20 out of 20).
 */

const CLOSED = 'locator.click: Target page, context or browser has been closed';

/** A popup that is closed or not, and whose `close` event comes when `close()` is called. */
function fakePopup(closed: boolean): { popup: Page; close(): void } {
  let state = closed;
  let fire: () => void = () => undefined;
  const event = new Promise<void>((resolve) => {
    fire = resolve;
  });
  if (closed) fire();
  const popup = {
    isClosed: () => state,
    waitForEvent: (name: string) => {
      if (name !== 'close') throw new Error(`no fake for the event ${name}`);

      return event;
    },
  } as unknown as Page;

  return {
    popup,
    close() {
      state = true;
      fire();
    },
  };
}

/** A locator whose click answers `click`. */
const fakeTarget = (click: () => Promise<void>): Locator => ({ click }) as unknown as Locator;

base.describe('clickThatClosesPopup, on its own', () => {
  base('ends well when the popup closed under the click and the click says so', async () => {
    const { popup } = fakePopup(true);

    await clickThatClosesPopup(
      popup,
      fakeTarget(() => Promise.reject(new Error(CLOSED))),
    );
  });

  base('throws any other error of the click, even when the popup is closed', async () => {
    const { popup } = fakePopup(true);
    const missed = new Error('locator.click: Timeout 30000ms exceeded.');

    await expect(
      clickThatClosesPopup(
        popup,
        fakeTarget(() => Promise.reject(missed)),
      ),
    ).rejects.toBe(missed);
  });

  base('throws the « closed » error when the popup is still open', async () => {
    const { popup } = fakePopup(false);

    await expect(
      clickThatClosesPopup(
        popup,
        fakeTarget(() => Promise.reject(new Error(CLOSED))),
      ),
    ).rejects.toThrow(CLOSED);
  });

  base('waits for the popup to close after a click that ends well', async () => {
    const fake = fakePopup(false);
    let clicked = false;

    await clickThatClosesPopup(
      fake.popup,
      fakeTarget(async () => {
        clicked = true;
        setTimeout(() => fake.close(), 50);
      }),
    );

    expect(clicked).toBe(true);
    expect(fake.popup.isClosed()).toBe(true);
  });
});

test('clickThatClosesPopup ends well when the popup of the extension closes during the click', async ({
  extension,
}) => {
  const page = await extension.context.newPage();
  await openBareSite(page, 'click-that-closes-popup');
  const popup = await openPopup(extension, page);
  // A button that is not there yet: `click()` waits for it, and the popup closes during that wait.
  await popup.evaluate(() => {
    const button = document.createElement('button');
    button.textContent = 'Closes under the click';
    button.hidden = true;
    document.body.prepend(button);
    setTimeout(() => window.close(), 300);
  });

  await clickThatClosesPopup(popup, popup.getByRole('button', { name: 'Closes under the click', includeHidden: true }));

  expect(popup.isClosed()).toBe(true);
});
