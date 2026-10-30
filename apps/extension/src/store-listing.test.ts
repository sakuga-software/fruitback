import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DEFAULT_CLOUD } from './popup-state.ts';

/**
 * The texts of the store listing, against the Fruitback this build signs in to (FRU-513).
 *
 * The listing said that the publisher runs no server that receives the notes. Since the Cloud is the
 * default of a build, that sentence is a false privacy statement on a public store page. The store
 * forms are pasted by hand from `store/listing.md`, so this file is the only place a test can read.
 */
describe('the store listing says where the notes go', () => {
  const listing = readFileSync(fileURLToPath(new URL('../store/listing.md', import.meta.url)), 'utf8');
  const loose = listing.replace(/\s+/g, ' ');

  it('names the Cloud of this build as the default destination', () => {
    const host = new URL(DEFAULT_CLOUD).host;
    assert.ok(
      loose.includes(`By default, to Fruitback Cloud (${host})`),
      `the listing does not say that the notes go to ${host} by default, the Cloud of this build`,
    );
  });

  it('does not say that the publisher receives no note, or that a reviewer needs a server of their own', () => {
    for (const sentence of [
      'runs no server that receives your notes',
      'YOU NEED A WORKER',
      'the Fruitback worker your team runs',
      "the feedback server that the reviewer's own team runs",
    ]) {
      assert.ok(!loose.includes(sentence), `the listing still says « ${sentence} »`);
    }
  });

  it('offers the button that the popup draws for a server of its own', () => {
    const popup = readFileSync(fileURLToPath(new URL('./popup-view.ts', import.meta.url)), 'utf8');
    const own = /t\('(Use your own Fruitback server)'\)/.exec(popup)?.[1];

    assert.ok(own !== undefined, 'the popup no longer offers a server of its own');
    assert.ok(loose.includes(`"${own}"`), `the listing does not quote « ${own} »`);
  });
});
