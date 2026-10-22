import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { type SeedStatus } from '@fruitback/shared';
import { STATUS_INK, statusLabel, statusPaint } from './status-paint.ts';
import { createTranslator } from './messages.ts';
import { THEME_STYLES } from './theme.ts';

/** How a note is painted and named by its status (FRU-370). See docs/decisions/statuses.md. */

const t = createTranslator({ language: 'en' });
const status = (fields: Partial<SeedStatus>): SeedStatus => ({ key: 'own:x', name: '', stage: 'progress', ...fields });

describe('statusPaint', () => {
  it('draws the stage with no status, or with a status that has no colour', () => {
    const stage = { fill: 'var(--fruitback-stage-progress)', ink: statusPaint({ stage: 'progress' }, undefined).ink };

    assert.equal(stage.ink, 'var(--fruitback-color-on-stage-progress, var(--fruitback-color-on-stage))');
    assert.deepEqual(statusPaint({ stage: 'progress' }, status({})), stage);
  });

  it('fills with the colour of the status, and writes the text colour the team chose', () => {
    assert.deepEqual(statusPaint({ stage: 'progress' }, status({ color: '#7dd3fc', textColor: '#000000' })), {
      fill: '#7dd3fc',
      ink: '#000000',
    });
  });

  it('computes the text colour on the ink of the theme when the team chose none', () => {
    // A light colour takes the ink (14.23:1), a dark one white (5.02:1, the ink is 3.53:1).
    assert.equal(statusPaint({ stage: 'progress' }, status({ color: '#fde68a' })).ink, '#18181b');
    assert.equal(statusPaint({ stage: 'done' }, status({ stage: 'done', color: '#15803d' })).ink, '#ffffff');
  });

  it('lets nothing but #rrggbb reach a style, whoever built the status', () => {
    for (const color of ['var(--x)', 'url(x)', 'red', '#fff', '#7dd3fc;x']) {
      assert.deepEqual(
        statusPaint({ stage: 'done' }, status({ stage: 'done', color, textColor: 'url(y)' })),
        statusPaint({ stage: 'done' }, undefined),
        color,
      );
    }
    // A bad text colour on a good background: computed instead.
    assert.equal(statusPaint({ stage: 'done' }, status({ color: '#15803d', textColor: 'var(--x)' })).ink, '#ffffff');
  });

  it('measures on the ink that the theme declares', () => {
    assert.match(THEME_STYLES, new RegExp(`--fruitback-color-ink: ${STATUS_INK};`));
  });
});

describe('statusLabel', () => {
  it('says the name of the status, then the word of the store, then the word of the stage', () => {
    const issue = { stage: 'progress' as const, stateName: 'In Review' };

    assert.equal(statusLabel(issue, status({ name: 'Waiting for the client' }), t), 'Waiting for the client');
    // An empty name is the catalog word, said by the store's word first, as before.
    assert.equal(statusLabel(issue, status({ name: '' }), t), 'In Review');
    assert.equal(statusLabel(issue, undefined, t), 'In Review');
    assert.equal(statusLabel({ ...issue, stateName: '' }, undefined, t), 'In progress');
  });
});
