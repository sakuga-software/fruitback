import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SEED_STAGES } from '@fruitback/shared';
import { THEME_STYLES, THEME_TOKENS, applyTheme, missingStageTokens, stageToken } from './theme.ts';
import { mountPage } from './dom.fixture.ts';

/**
 * The token layer (SKG-528). None of this can be seen in happy-dom — it draws nothing and resolves
 * no `var()` — so what is asserted here is the *contract*: which names exist, which are declared,
 * and what `applyTheme` will and will not write. What it looks like is `e2e/` and a recording.
 */

describe('the token declarations', () => {
  /**
   * Only the first `:host` block — the one outside every media query.
   *
   * The first version of this searched the whole stylesheet, and a mutation proved it worthless:
   * deleting a token from the base block still passed, because the dark block redeclares it. A token
   * declared only under `prefers-color-scheme: dark` is undefined in light mode, which is exactly the
   * defect this is for.
   */
  const baseBlock = THEME_STYLES.slice(0, THEME_STYLES.indexOf('@media'));

  it('declares every settable token in the base block, not only under a media query', () => {
    const undeclared = THEME_TOKENS.filter((token) => !baseBlock.includes(`--fb-${token}:`));

    assert.deepEqual(undeclared, [], 'these tokens are settable but never declared unconditionally');
  });

  it('has a token for every stage the contract names', () => {
    // A stage with no token renders a pin with no colour at all — `var()` falls back to nothing.
    assert.deepEqual(missingStageTokens(), []);

    for (const stage of SEED_STAGES) {
      assert.ok(baseBlock.includes(`--fb-stage-${stage}:`), `${stage} has no unconditional declaration`);
      assert.equal(stageToken(stage), `var(--fb-stage-${stage})`);
    }
  });

  it('redefines colours for a dark scheme, and durations in neither', () => {
    // A widget that lays a white popover over a dark site at three in the morning gets turned off.
    assert.match(THEME_STYLES, /@media \(prefers-color-scheme: dark\)/);
    assert.match(THEME_STYLES, /@media \(prefers-contrast: more\)/);

    const dark = THEME_STYLES.slice(THEME_STYLES.indexOf('prefers-color-scheme: dark'));
    assert.ok(dark.includes('--fb-color-surface:'), 'dark does not restate the surface colour');
    assert.ok(!dark.includes('--fb-duration-'), 'a duration has no business changing with the scheme');
  });

  it('carries no backtick, because one would close the literal it lives in', () => {
    // Four incidents in this repo, twice while writing a comment about a different bug. The module
    // stops parsing and the cause reads as a mystery until you look at the right line.
    assert.ok(!THEME_STYLES.includes('`'));
  });
});

describe('applyTheme', () => {
  const host = () => mountPage('<main></main>').document.createElement('div');

  it('writes the tokens a host asked for', () => {
    const element = host();

    applyTheme(element, { 'color-accent': '#0055ff', 'stage-ripe': 'rebeccapurple' });

    assert.equal(element.style.getPropertyValue('--fb-color-accent'), '#0055ff');
    assert.equal(element.style.getPropertyValue('--fb-stage-ripe'), 'rebeccapurple');
  });

  it('ignores a name it does not know, rather than writing it', () => {
    // This is what keeps `theme` from becoming a way to set arbitrary properties on the host element,
    // and what makes a token renamed in a later version cost that override and never the mount.
    const element = host();

    applyTheme(element, { 'colour-accent': 'red', position: 'fixed' } as never);

    assert.equal(element.style.getPropertyValue('--fb-colour-accent'), '');
    assert.equal(element.style.getPropertyValue('--fb-position'), '');
    assert.equal(element.style.position, '');
  });

  it('leaves the element alone when there is no theme', () => {
    const element = host();

    applyTheme(element, undefined);
    applyTheme(element, {});

    assert.equal(element.getAttribute('style'), null);
  });
});
