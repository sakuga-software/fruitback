import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { claudeLine, daysOf, endOf, keyEnd, statusKey } from './agent-keys.ts';

const NOW = Date.UTC(2026, 9, 28, 12, 0, 0);
const DAY = 86_400_000;
const at = (ms: number) => ({ expiresAt: new Date(NOW + ms).toISOString() });

describe('the end of an agent key (FRU-462)', () => {
  it('is near from 7 days before it, counted in whole days, and passed at its moment', () => {
    assert.deepEqual(keyEnd(at(8 * DAY), NOW), { state: 'ok' });
    assert.deepEqual(keyEnd(at(7 * DAY + 1), NOW), { state: 'ok' });
    assert.deepEqual(keyEnd(at(7 * DAY), NOW), { state: 'soon', days: 7 });
    assert.deepEqual(keyEnd(at(5 * DAY - 3_600_000), NOW), { state: 'soon', days: 5 });
    assert.deepEqual(keyEnd(at(1), NOW), { state: 'soon', days: 1 });
    // The worker refuses a key from its end on.
    assert.deepEqual(keyEnd(at(0), NOW), { state: 'ended' });
    assert.deepEqual(keyEnd(at(-DAY), NOW), { state: 'ended' });
    assert.deepEqual(keyEnd({ expiresAt: 'not a date' }, NOW), { state: 'ok' });
  });

  it('is the days typed after now, as the worker computes it', () => {
    assert.equal(endOf(90, NOW), new Date(NOW + 90 * DAY).toISOString());
  });
});

describe('the form of a key (FRU-462)', () => {
  it('takes a whole number of days from 1 to 365, and nothing else', () => {
    assert.equal(daysOf('90'), 90);
    assert.equal(daysOf(' 1 '), 1);
    assert.equal(daysOf('365'), 365);
    for (const typed of ['0', '366', '', '1.5', '-3', '1e2', 'ninety']) assert.equal(daysOf(typed), undefined, typed);
  });
});

describe('the line for Claude Code (FRU-462)', () => {
  it('is the one of docs/agents.md, with the address of the worker and the key', () => {
    assert.equal(
      claudeLine('https://api.fruitback.com', 'fbk_secret'),
      'claude mcp add --transport http fruitback https://api.fruitback.com/mcp \\\n  --header "Authorization: Bearer fbk_secret"',
    );
  });
});

describe('the status an agent set (FRU-462)', () => {
  it('is the key of the status, with no own:', () => {
    assert.equal(statusKey('own:done'), 'done');
    assert.equal(statusKey('own:waiting-for-client'), 'waiting-for-client');
    assert.equal(statusKey(undefined), '');
  });
});
