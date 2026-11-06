import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DECLINE_DAYS, NOTIFY_ASK_KEY, createNotifyAsk } from './notify-ask.ts';

/** « Want to know when it's fixed? »: once per browser, a « No thanks » for 30 days (FRU-604). */

function storage(): Storage & { items: Map<string, string> } {
  const items = new Map<string, string>();

  return {
    items,
    get length() {
      return items.size;
    },
    clear: () => items.clear(),
    getItem: (key) => items.get(key) ?? null,
    key: (index) => [...items.keys()][index] ?? null,
    removeItem: (key) => void items.delete(key),
    setItem: (key, value) => void items.set(key, value),
  };
}

const DAY = 24 * 60 * 60 * 1000;

describe('the question of a note done, in this browser', () => {
  it('is asked until it is answered', () => {
    const ask = createNotifyAsk(storage());
    assert.equal(ask.asks(), true);
    assert.equal(ask.asks(), true);
  });

  it('is never asked again after « Notify me », and keeps no address', () => {
    const kept = storage();
    const ask = createNotifyAsk(kept);
    ask.accepted();
    assert.equal(ask.asks(), false);
    assert.equal(createNotifyAsk(kept).asks(), false, 'another load of the page');
    assert.deepEqual([...kept.items.values()], ['{"answer":"yes"}']);
  });

  it(`comes back ${DECLINE_DAYS} days after « No thanks », and not before`, () => {
    let now = 1_800_000_000_000;
    const kept = storage();
    const ask = createNotifyAsk(kept, () => now);
    ask.declined();
    now += DECLINE_DAYS * DAY - 1;
    assert.equal(ask.asks(), false);
    now += 1;
    assert.equal(ask.asks(), true);
  });

  it('reads a « No thanks » of a day to come, or of no day, as one of now', () => {
    const kept = storage();
    kept.setItem(NOTIFY_ASK_KEY, JSON.stringify({ answer: 'no', at: Date.now() + 365 * DAY }));
    assert.equal(createNotifyAsk(kept).asks(), false);
    kept.setItem(NOTIFY_ASK_KEY, JSON.stringify({ answer: 'no' }));
    assert.equal(createNotifyAsk(kept).asks(), false);
    kept.setItem(NOTIFY_ASK_KEY, 'not json');
    assert.equal(createNotifyAsk(kept).asks(), true);
  });

  it('keeps the answer for the page when the browser refuses its storage', () => {
    const refusing = storage();
    refusing.setItem = () => {
      throw new Error('QuotaExceededError');
    };
    refusing.getItem = () => {
      throw new Error('SecurityError');
    };
    const ask = createNotifyAsk(refusing);
    ask.declined();
    assert.equal(ask.asks(), false);
    assert.equal(createNotifyAsk(null).asks(), true);
  });
});
