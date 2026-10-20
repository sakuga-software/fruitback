import { expect } from '@playwright/test';
import { test } from './extension.ts';

/**
 * A first install opens the welcome page of the extension (FRU-318): pin Fruitback, then sign in
 * from its popup. Loading an unpacked extension into a fresh profile is an install, with the reason
 * `install`, so the page opens by itself.
 */
test('a first install opens the page that says to pin Fruitback, then to sign in', async ({ extension }) => {
  const url = `chrome-extension://${extension.id}/welcome.html`;
  const welcome =
    extension.context.pages().find((page) => page.url() === url) ??
    (await extension.context.waitForEvent('page', { predicate: (page) => page.url() === url }));

  await expect(welcome.getByRole('heading', { level: 1 })).toHaveText('Fruitback is installed');
  await expect(welcome).toHaveTitle('Welcome to Fruitback');
  await expect(welcome.locator('ol > li > strong')).toHaveText(['Pin Fruitback', 'Sign in']);
  await expect(welcome.getByText('Click the Fruitback icon, then Sign in with email.')).toBeVisible();

  // « Open Fruitback » opens the popup, or says where the icon is when the browser does not let it.
  await welcome.getByRole('button', { name: 'Open Fruitback' }).click();
  const said = welcome.getByRole('status');
  await expect
    .poll(async () => {
      const text = await said.textContent();
      const popup = extension.context.pages().some((page) => page.url().endsWith('/popup.html'));

      return popup || text === 'Your browser did not open it from this page: click the Fruitback icon in the toolbar.';
    })
    .toBe(true);

  // Only one welcome page: the background opens it at the install, not at each start.
  expect(extension.context.pages().filter((page) => page.url() === url)).toHaveLength(1);
});
