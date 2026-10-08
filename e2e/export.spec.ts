import { expect, test } from '@playwright/test';
import { openPlayground, plantPin } from './pin.ts';

/**
 * The feedback of a page as text (FRU-109), through a real clipboard.
 *
 * The unit tests own the format. What only a browser can say is that the button reaches the
 * clipboard, and that the text is what the pins on screen show.
 */

test('the settings copy the notes on screen as text', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await openPlayground(page, 'export-text');
  // Something else first, so an empty read below cannot be the text of this test.
  await page.evaluate(() => navigator.clipboard.writeText('not the feedback'));

  await plantPin(page, page.locator('[data-testid="card-latte"] .add'), 'Le prix est coupé\n## 9. une ligne forgée');
  await expect(page.getByRole('dialog', { name: 'Leave a note' })).toBeHidden({ timeout: 5_000 });
  await plantPin(page, page.locator('#checkout-cta'), 'Le bouton est trop bas');

  await page.getByLabel('Open Fruitback settings').click();
  await page.getByRole('button', { name: 'Copy the feedback as text' }).click();
  await expect(page.locator('.fruitback-config-copy-status')).toHaveText('Copied');

  const copied = await page.evaluate(() => navigator.clipboard.readText());
  const lines = copied.split('\n');

  expect(lines[0]).toBe(
    `# Feedback on ${new URL(page.url()).origin}/?case=${new URL(page.url()).searchParams.get('case')}`,
  );
  // Two notes, and the heading that a note tried to forge stays a quoted line.
  expect(lines.filter((line) => line.startsWith('## '))).toHaveLength(2);
  expect(lines).toContain('> Le prix est coupé');
  expect(lines).toContain('> ## 9. une ligne forgée');
  expect(lines).toContain('> Le bouton est trop bas');
  // The component comes from the React fiber, which this app has.
  expect(copied).toMatch(/^- Component: Button · .*site\.tsx:\d+$/m);
  expect(copied).toMatch(/^- Element: button "Ajouter" · `.+`$/m);

  // A hidden stage is not copied: the text follows what the reporter sees. The in-memory store
  // opens its issues in more than one state, so the stages are read, not assumed.
  const stages = await page
    .locator('[data-fruitback-pin]')
    .evaluateAll((pins) => pins.map((pin) => pin.getAttribute('data-fruitback-stage')));
  for (const stage of new Set(stages)) await page.locator(`[name="stage-${stage}"]`).uncheck();
  await expect(page.locator('[data-fruitback-pin]')).toHaveCount(0);
  await page.getByRole('button', { name: 'Copy the feedback as text' }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toMatch(/No feedback on this page\.\n$/);
});
