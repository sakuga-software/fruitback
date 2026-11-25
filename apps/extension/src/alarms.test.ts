import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { promisedAlarms } from './alarms.ts';

describe('the alarms of the background (FRU-668)', () => {
  it('answers a promise when the browser answers undefined, as Safari does', async () => {
    const made: string[] = [];
    const alarms = promisedAlarms<{ periodInMinutes: number }>({
      create: (name) => void made.push(name),
      clear: () => undefined,
    });

    await alarms.set('badge', { periodInMinutes: 1 }).catch(assert.fail);
    await alarms.clear('badge').catch(assert.fail);
    assert.deepEqual(made, ['badge']);
  });

  it('turns a refusal of the browser into a rejection, thrown or answered', async () => {
    const thrown = promisedAlarms({
      create: () => {
        throw new Error('refused');
      },
      clear: () => Promise.reject(new Error('refused')),
    });

    await assert.rejects(thrown.set('badge', {}), /refused/);
    await assert.rejects(thrown.clear('badge'), /refused/);
  });

  it('is the only way the background reaches browser.alarms to set or clear one', () => {
    const background = readFileSync(new URL('../entrypoints/background.ts', import.meta.url), 'utf8');

    assert.equal(/browser\.alarms\s*\.\s*(create|clear)\b/.test(background), false);
    assert.ok(background.includes('promisedAlarms(browser.alarms)'));
  });
});
