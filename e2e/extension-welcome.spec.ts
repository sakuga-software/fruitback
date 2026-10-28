import { expect } from '@playwright/test';
import { test } from './extension.ts';

test.use({ keepWelcome: true });

/**
 * A first install opens the welcome page of the extension (FRU-318): pin Fruitback, then sign in
 * on the page itself (FRU-482). Loading an unpacked extension into a fresh profile is an install, with the reason
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
  // The build names a Fruitback: the page signs in itself (FRU-482), and has no way to the popup.
  await expect(welcome.getByText('Here, with the email of your work.')).toBeVisible();
  await expect(welcome.getByRole('button', { name: 'Sign in with email' })).toBeVisible();
  await expect(welcome.getByRole('button', { name: 'Open Fruitback' })).toHaveCount(0);

  // Only one welcome page: the background opens it at the install, not at each start.
  expect(extension.context.pages().filter((page) => page.url() === url)).toHaveLength(1);
});
