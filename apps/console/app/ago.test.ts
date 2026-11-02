import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ago, agoInSentence } from './ago.ts';
import { setLocale } from './i18n.ts';

// Noon of a day, in the time zone of the machine: « Yesterday » is the day before, whatever the zone.
const NOW = new Date(2026, 9, 13, 12, 0, 0).getTime();
const before = (ms: number) => new Date(NOW - ms).toISOString();
const MIN = 60_000;

describe('how long ago something happened, in the words of the mockup', () => {
  beforeEach(() => void setLocale('en', false));
  afterEach(() => void setLocale('en', false));

  it('says minutes, then hours, on the same day', () => {
    assert.equal(ago(before(20_000), NOW), 'Just now');
    assert.equal(ago(before(12 * MIN), NOW), '12 min ago');
    assert.equal(ago(before(59 * MIN), NOW), '59 min ago');
    assert.equal(ago(before(60 * MIN), NOW), '1 h ago');
    assert.equal(ago(before(2 * 60 * MIN + 59 * MIN), NOW), '2 h ago');
  });

  it('says hours for the 24 hours before, whatever the day: 22:30 read at 00:30 is « 2 h ago »', () => {
    const halfPastMidnight = new Date(2026, 9, 13, 0, 30).getTime();
    assert.equal(ago(new Date(2026, 9, 12, 22, 30).toISOString(), halfPastMidnight), '2 h ago');
    assert.equal(ago(new Date(2026, 9, 12, 1, 0).toISOString(), halfPastMidnight), '23 h ago');
    // 11 pm the day before, at noon: 13 hours.
    assert.equal(ago(new Date(2026, 9, 12, 23, 0).toISOString(), NOW), '13 h ago');
  });

  it('says « Yesterday » past 24 hours, for the day before in the calendar', () => {
    const halfPastMidnight = new Date(2026, 9, 13, 0, 30).getTime();
    assert.equal(ago(new Date(2026, 9, 12, 0, 0).toISOString(), halfPastMidnight), 'Yesterday');
    assert.equal(ago(new Date(2026, 9, 11, 23, 30).toISOString(), halfPastMidnight), '2 days ago');
    assert.equal(ago(new Date(2026, 9, 12, 0, 30).toISOString(), NOW), 'Yesterday');
  });

  it('says days for the week, then the day, with its year when it is not this year', () => {
    assert.equal(ago(new Date(2026, 9, 11, 9, 0).toISOString(), NOW), '2 days ago');
    assert.equal(ago(new Date(2026, 9, 7, 9, 0).toISOString(), NOW), '6 days ago');
    assert.equal(ago(new Date(2026, 9, 6, 9, 0).toISOString(), NOW), 'Oct 6');
    assert.equal(ago(new Date(2026, 9, 3, 9, 0).toISOString(), NOW), 'Oct 3');
    assert.equal(ago(new Date(2025, 11, 30, 9, 0).toISOString(), NOW), 'Dec 30, 2025');
  });

  it('reads a moment ahead of the browser as now, and shows what it cannot read', () => {
    assert.equal(ago(new Date(NOW + 5 * MIN).toISOString(), NOW), 'Just now');
    assert.equal(ago('not a date', NOW), 'not a date');
  });

  it('speaks French', async () => {
    await setLocale('fr', false);
    assert.equal(ago(before(12 * MIN), NOW), 'il y a 12 min');
    assert.equal(ago(before(2 * 60 * MIN), NOW), 'il y a 2 h');
    assert.equal(ago(new Date(2026, 9, 12, 9, 0).toISOString(), NOW), 'Hier');
    assert.equal(ago(before(10_000), NOW), 'À l’instant');
    assert.equal(ago(new Date(2026, 9, 10, 9, 0).toISOString(), NOW), 'il y a 3 jours');
    assert.equal(ago(new Date(2026, 9, 3, 9, 0).toISOString(), NOW), '3 oct.');
  });

  // FRU-516: « Connected 30 Oct · used Just now » had a capital in the middle of a sentence.
  it('says it in small letters inside a sentence, and the day with its preposition', () => {
    assert.equal(agoInSentence(before(20_000), NOW), 'just now');
    assert.equal(agoInSentence(before(12 * MIN), NOW), '12 min ago');
    assert.equal(agoInSentence(new Date(2026, 9, 12, 9, 0).toISOString(), NOW), 'yesterday');
    assert.equal(agoInSentence(new Date(2026, 9, 3, 9, 0).toISOString(), NOW), 'on Oct 3');
    // The cell of a table keeps its capital.
    assert.equal(ago(before(20_000), NOW), 'Just now');
  });

  it('says it inside a French sentence too', async () => {
    await setLocale('fr', false);
    assert.equal(agoInSentence(before(20_000), NOW), 'à l’instant');
    assert.equal(agoInSentence(new Date(2026, 9, 12, 9, 0).toISOString(), NOW), 'hier');
    assert.equal(agoInSentence(new Date(2026, 9, 3, 9, 0).toISOString(), NOW), 'le 3 oct.');
  });
});
