import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ago, agoInSentence, dayIn, dayOf, moment, seenOn } from './ago.ts';
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

// FRU-508: `dayOf` was written three times, `moment` three times, and « Last seen » once more in Members.
describe('a day, a moment and a day seen, in one module', () => {
  beforeEach(() => void setLocale('en', false));
  afterEach(() => void setLocale('en', false));

  const thisYear = new Date().getFullYear();
  const inThisYear = new Date(thisYear, 9, 3, 12).toISOString();
  const lastYear = new Date(thisYear - 1, 9, 3, 12).toISOString();

  it('writes a day first, with its year when it is not this year', () => {
    assert.equal(dayOf(inThisYear), '3 Oct');
    assert.equal(dayOf(lastYear), `3 Oct ${thisYear - 1}`);
  });

  it('writes the year always, or never, when asked', () => {
    assert.equal(dayOf(inThisYear, 'always'), `3 Oct ${thisYear}`);
    assert.equal(dayOf(lastYear, 'never'), '3 Oct');
    assert.equal(dayIn(inThisYear, 'always'), `3 Oct ${thisYear}`);
  });

  it('shows a date that is not one as written, or as nothing when the caller has its own word', () => {
    assert.equal(dayOf('not a date'), 'not a date');
    assert.equal(dayIn('not a date'), undefined);
    assert.equal(dayIn(undefined), undefined);
  });

  it('writes a day in French', async () => {
    await setLocale('fr', false);
    assert.equal(dayOf(inThisYear), '3 oct.');
    assert.equal(dayOf(lastYear), `3 oct. ${thisYear - 1}`);
  });

  it('writes a moment with its time, and a moment that is not one as written', () => {
    const at = new Date(2026, 9, 3, 14, 5).toISOString();
    assert.equal(moment(at), new Date(at).toLocaleString('en', { dateStyle: 'medium', timeStyle: 'short' }));
    assert.match(moment(at), /2026/);
    assert.equal(moment('not a date'), 'not a date');
  });

  it('says the day somebody was last seen, in days of UTC', () => {
    const now = Date.parse('2026-10-13T12:00:00Z');
    assert.equal(seenOn(undefined, now), 'Not seen yet');
    assert.equal(seenOn('2026-10-13', now), 'Today');
    assert.equal(seenOn('2026-10-12', now), 'Yesterday');
    assert.equal(seenOn('2026-10-10', now), '3 days ago');
    assert.equal(seenOn('2026-10-07', now), '6 days ago');
    assert.equal(seenOn('2026-10-06', now), '6 Oct');
    // A day after today (a clock of the worker ahead) is today.
    assert.equal(seenOn('2026-10-14', now), 'Today');
    assert.equal(seenOn('not a day', now), 'not a day');
  });
});
