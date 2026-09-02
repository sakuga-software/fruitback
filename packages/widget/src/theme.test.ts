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
    // Five incidents in this repo now, and the fifth was in this very file: a CSS comment written
    // three lines below the paragraph forbidding it.
    //
    // Be clear about what this catches, because it did *not* catch that one. An odd number of
    // backticks stops the module parsing, so the test cannot run at all — loud, but the cause reads
    // as a mystery until you look at the right line. What this guards is the quiet case: an even
    // number, which parses fine and silently truncates the stylesheet.
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

describe('a foreground token is only ever used on the background it is named for', () => {
  /**
   * The defect this exists for was mine, and review caught it (SKG-528).
   *
   * The original CSS said `color: #fff` in five places, and mapping that to a single
   * `--fb-color-on-accent` coupled three elements whose background is not the accent: the gear
   * (`--fb-color-chip`), every pin badge (`--fb-pin-color`) and the orphan chip
   * (`--fb-color-warning`). Nothing looked wrong, because all four tokens hold `#fff` — a host
   * pairing a pale `color-accent` with a dark `color-on-accent` is what would have turned those
   * three into dark text on their unchanged dark fills.
   *
   * Read out of the source rather than off an export, because what is being checked *is* the
   * stylesheet text and there is no value to import — the five `STYLES` are module-local, and
   * `index.ts` re-exports with `export *`, so five identically named exports would collide and be
   * dropped in silence.
   */
  const PAIRS: Record<string, string> = {
    'on-accent': '--fb-color-accent',
    'on-chip': '--fb-color-chip',
    'on-stage': '--fb-pin-color',
    'on-warning': '--fb-color-warning',
  };

  const MODULES = ['host', 'overlay', 'composer', 'panel', 'orphans'];

  async function declarationBlocks(): Promise<{ where: string; body: string }[]> {
    const { readFile } = await import('node:fs/promises');
    const { fileURLToPath } = await import('node:url');
    const blocks: { where: string; body: string }[] = [];

    for (const name of MODULES) {
      const path = fileURLToPath(new URL(`./${name}.ts`, import.meta.url));
      const source = await readFile(path, 'utf8');

      // Rule bodies, crudely but sufficiently: these stylesheets are hand-written and flat.
      for (const [, body] of source.matchAll(/\{([^{}]*)\}/g)) {
        if (body !== undefined) blocks.push({ where: `${name}.ts`, body });
      }
    }

    return blocks;
  }

  it('finds every foreground token beside its paired background', async () => {
    const blocks = await declarationBlocks();
    const wrong: string[] = [];
    let checked = 0;

    for (const { where, body } of blocks) {
      for (const [token, background] of Object.entries(PAIRS)) {
        if (!body.includes(`var(--fb-color-${token})`)) continue;

        checked += 1;
        if (!body.includes(`var(${background})`)) wrong.push(`${where}: ${token} without ${background}`);
      }
    }

    // Asserted, because a regex that silently matches nothing is a test that passes for free.
    assert.ok(checked >= 5, `only ${checked} foreground uses found — the block regex stopped matching`);
    assert.deepEqual(wrong, []);
  });

  it('declares a foreground for each background that gets filled', async () => {
    for (const token of Object.keys(PAIRS)) {
      assert.ok(THEME_TOKENS.includes(`color-${token}` as never), `color-${token} is used but not settable`);
    }
  });
});
