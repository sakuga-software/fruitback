import { createHash } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { type Bench, startBench } from './bench.ts';
import { mountTheSiteWidget, readSeeds } from './extension.ts';

/**
 * The bench of the extension, driven as an agent drives it (FRU-426): team mode on a site that
 * members only read, a capture after the click on the icon, a file of the disk, and the files in
 * the fake Linear of the connector of the site.
 */

let bench: Bench | undefined;

test.afterEach(async () => {
  await bench?.close();
  bench = undefined;
});

test('the bench sends a note in team mode, with a capture after the click on the icon and a file, to the tracker', async () => {
  test.setTimeout(120_000);
  bench = await startBench({ headed: false });
  const site = await bench.openSite(`ext-bench-${test.info().retry}-${test.info().repeatEachIndex}`);

  // Team mode: the page alone reads nothing on this site, so a pin read back came through the relay.
  expect((await readSeeds(site, bench.worker)).status).toBe(401);
  await expect(site.getByRole('button', { name: 'Team feedback' })).toBeVisible();

  test.info().annotations.push({ type: 'gesture', description: bench.gesture });
  // The control: without the click on the icon, the browser refuses the capture. With `<all_urls>`
  // (a Chromium with no `Extensions.triggerAction`, the one of CI) no gesture is needed, so there is
  // nothing to refuse.
  if (bench.gesture === 'click') {
    await site.getByRole('button', { name: 'Team feedback' }).click();
    await site.locator('[data-testid="card-latte"] .add').click();
    const files = site.getByRole('group', { name: 'Attachments' });
    await files.getByRole('button', { name: 'Attach' }).click();
    await files.getByRole('menuitem', { name: 'Capture an area' }).click();
    await expect(site.getByRole('dialog', { name: 'Choose an area of the page' })).toBeVisible();
    await site.keyboard.press('Enter');
    const refused = site.locator('.fruitback-composer-file');
    await expect(refused).toHaveAttribute('data-fruitback-file', 'refused');
    // FRU-423: a refusal for want of a gesture says what to do.
    await expect(refused).toContainText('Click the Fruitback icon in the toolbar, then try again.');
    await site.getByRole('button', { name: 'Cancel', exact: true }).click();
  }

  await bench.grantActiveTab(site);
  const log = { name: 'bench.log', mimeType: 'text/plain', buffer: Buffer.from('une ligne du banc') };
  await bench.leaveNote(site, { text: 'Note du banc', attach: ['area', log] });
  await bench.screenshot(site, test.info().outputPath('bench.png'));

  const received = await bench.trackerReceived();
  const issue = received.issues.find((each) => each.description.includes('Note du banc'));
  expect(issue).toBeDefined();
  expect(received.attachments.filter((each) => each.issueId === issue?.id).map((each) => each.title)).toEqual([
    'area.png',
    'bench.log',
  ]);
  const [area, text] = received.puts.slice(-2);
  expect(area?.type).toBe('image/png');
  expect(area?.bytes).toBeGreaterThan(1000);
  expect(text).toMatchObject({
    type: 'text/plain',
    bytes: log.buffer.byteLength,
    sha256: createHash('sha256').update(log.buffer).digest('hex'),
  });

  // The pin comes back after a reload, read from the tracker through the relay.
  await site.reload();
  await expect(site.getByRole('heading', { name: 'Nos formules' })).toBeVisible();
  await mountTheSiteWidget(site, bench.worker);
  await expect(site.locator('[data-fruitback-pin]')).toHaveCount(1);
  await site.getByRole('button', { name: /^Note 1\b/ }).click();
  await expect(site.locator('[data-fruitback-files]')).toHaveText(/^2 attachments · in \S+$/);
});

test('the bench loads a second copy of the extension beside the first, with an id of its own (FRU-397)', async () => {
  bench = await startBench({ headed: false, paired: false, moreCopies: ['copy'] });
  expect(bench.moreCopies).toHaveLength(1);
  expect(bench.moreCopies[0]).not.toBe(bench.extension.id);
  const ids = bench.context.serviceWorkers().map((each) => new URL(each.url()).host);
  expect(ids.sort()).toEqual([bench.extension.id, ...bench.moreCopies].sort());
});
