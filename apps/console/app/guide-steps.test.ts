import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FRENCH as EXTENSION_FRENCH } from '../../extension/src/messages.fr.ts';
import { GUIDE_CONSOLE, GUIDE_DOCS, REVIEWING, reviewingWithGuide } from '../guide-docs.ts';
import { GUIDE_CAPTURED } from './guide-captured.ts';
import { GUIDE_EXTRA_CAPTURES, GUIDE_STEPS, type GuideControl, guideMarkdown, guideParts } from './guide-steps.ts';
import { FRENCH } from './messages.fr.ts';

/**
 * The guide of the extension (FRU-486): one source, its copy in the docs, its captures, and the
 * names of the controls it quotes.
 *
 * `e2e/first-note.spec.ts` finds each control on the built extension, by its role and its name. These
 * checks are the ones that need no browser: they run in `pnpm test`, on every pull request.
 */
const read = (path: string): string => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');
const DOCS = fileURLToPath(new URL('../../../docs/', import.meta.url));

/** The sources of a part, as text: the screens hand their words to `t`. */
function sourcesOf(folder: string): string {
  const root = fileURLToPath(new URL(folder, import.meta.url));

  return readdirSync(root, { recursive: true, encoding: 'utf8' })
    .filter((file) => /\.tsx?$/.test(file) && !file.endsWith('.test.ts') && !file.includes('messages.'))
    .map((file) => readFileSync(join(root, file), 'utf8'))
    .join('\n');
}

const extension = `${sourcesOf('../../extension/src/')}\n${sourcesOf('../../extension/entrypoints/')}`;
const consoleScreens = sourcesOf('./routes/');

/** Whether the screens of the part of `control` hand its English name to `t`. */
function drawn(control: GuideControl, screens: { extension: string; console: string }): boolean {
  const source = screens[control.where];

  return source.includes(`t('${control.name}'`) || source.includes(`t("${control.name}"`);
}

describe('the guide of the extension (FRU-486)', () => {
  it('names each control it quotes, and quotes each control it names', () => {
    for (const step of GUIDE_STEPS) {
      const quoted = guideParts(step.text).flatMap((part) => ('control' in part ? [part.control] : []));
      assert.deepEqual([...quoted].sort(), Object.keys(step.controls).sort(), step.id);
    }
  });

  it('quotes controls that the extension and the console draw today', () => {
    const controls = GUIDE_STEPS.flatMap((step) => Object.values(step.controls));
    assert.ok(controls.length >= 4, `read ${controls.length} controls`);
    for (const control of controls) {
      assert.ok(drawn(control, { extension, console: consoleScreens }), `no screen draws « ${control.name} »`);
    }
  });

  it('finds a control that no screen draws, so the check above is not empty by accident', () => {
    const renamed: GuideControl = { role: 'button', name: 'Sign in by email', where: 'extension' };

    assert.equal(drawn(renamed, { extension, console: consoleScreens }), false);
    assert.equal(drawn({ ...renamed, name: 'Sign in with email' }, { extension, console: '' }), true);
    assert.equal(
      drawn({ ...renamed, name: 'Sign in with email', where: 'console' }, { extension, console: '' }),
      false,
    );
  });

  it('reads the controls of the extension in French as the extension draws them', () => {
    for (const control of GUIDE_STEPS.flatMap((step) => Object.values(step.controls))) {
      if (control.where !== 'extension') continue;
      assert.equal(FRENCH[control.name], EXTENSION_FRENCH[control.name], control.name);
    }
  });

  it('has a capture for each step and for each capture it shows elsewhere, and no other', () => {
    const names = [...GUIDE_STEPS.map((step) => step.id), ...GUIDE_EXTRA_CAPTURES];
    for (const name of names) assert.ok(existsSync(join(GUIDE_DOCS, `${name}.png`)), `docs/assets/guide/${name}.png`);
    assert.deepEqual(readdirSync(GUIDE_DOCS).sort(), names.map((name) => `${name}.png`).sort());
  });

  /** The console's image is built from `apps/` and `packages/`: it serves a copy, which must be the same. */
  it('serves in the console the same captures as the docs', () => {
    assert.deepEqual(readdirSync(GUIDE_CONSOLE).sort(), readdirSync(GUIDE_DOCS).sort());
    for (const file of readdirSync(GUIDE_DOCS)) {
      assert.ok(readFileSync(join(GUIDE_CONSOLE, file)).equals(readFileSync(join(GUIDE_DOCS, file))), file);
    }
  });

  it('shows each capture outside of the steps in a guide of the docs', () => {
    const docs = readdirSync(DOCS)
      .filter((file) => file.endsWith('.md'))
      .map((file) => readFileSync(join(DOCS, file), 'utf8'))
      .join('\n');
    for (const name of GUIDE_EXTRA_CAPTURES) assert.ok(docs.includes(`(assets/guide/${name}.png)`), name);
  });

  it('says which version of the extension the captures show', () => {
    assert.match(GUIDE_CAPTURED.extension, /^\d+\.\d+\.\d+$/);
    const version = (JSON.parse(read('../../extension/package.json')) as { version: string }).version;
    const order = (text: string): number[] => text.split('.').map(Number);
    const [a, b] = [order(GUIDE_CAPTURED.extension), order(version)];
    assert.ok(
      (a[0] ?? 0) * 1e6 + (a[1] ?? 0) * 1e3 + (a[2] ?? 0) <= (b[0] ?? 0) * 1e6 + (b[1] ?? 0) * 1e3 + (b[2] ?? 0),
      `the captures say ${GUIDE_CAPTURED.extension}, past the extension ${version}`,
    );
  });

  it('is copied as it is into docs/reviewing.md: run `node apps/console/guide-docs.ts` after a change', () => {
    assert.equal(readFileSync(REVIEWING, 'utf8'), reviewingWithGuide());
    assert.ok(readFileSync(REVIEWING, 'utf8').includes(guideMarkdown(GUIDE_CAPTURED)));
  });
});
