import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { pageWindow } from './page-window.ts';

describe('the pages a list offers to go to directly (FRU-587)', () => {
  it('shows every page of a short list', () => {
    assert.deepEqual(pageWindow(1, 1), [1]);
    assert.deepEqual(pageWindow(2, 3), [1, 2, 3]);
    assert.deepEqual(pageWindow(3, 5), [1, 2, 3, 4, 5]);
  });

  it('shows the first, the last and the pages beside the one shown, with « … » between', () => {
    assert.deepEqual(pageWindow(1, 11), [1, 2, 'gap', 11]);
    assert.deepEqual(pageWindow(6, 11), [1, 'gap', 5, 6, 7, 'gap', 11]);
    assert.deepEqual(pageWindow(11, 11), [1, 'gap', 10, 11]);
  });

  it('shows one page alone between two, never « … » for it', () => {
    assert.deepEqual(pageWindow(4, 11), [1, 2, 3, 4, 5, 'gap', 11]);
    assert.deepEqual(pageWindow(8, 11), [1, 'gap', 7, 8, 9, 10, 11]);
  });

  it('leaves out the pages a list cannot reach, and says « … » where they are', () => {
    // A list read by a cursor, walked from the first page to the sixth: the pages before, and the next.
    const walked = (page: number) => page <= 7;
    assert.deepEqual(pageWindow(6, 11, walked), [1, 'gap', 5, 6, 7, 'gap']);
    // The same list opened from a link to the sixth page: the first page and the next one only.
    const opened = (page: number) => page === 1 || page === 7;
    assert.deepEqual(pageWindow(6, 11, opened), [1, 'gap', 6, 7, 'gap']);
    // The page shown is always there, even past a count read before the list grew.
    assert.deepEqual(pageWindow(3, 2), [1, 2, 3]);
  });
});
