import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ACCENT_IDS,
  type Appearance,
  DARK_PRESETS,
  DEFAULT_APPEARANCE,
  FONT_SIZES,
  LIGHT_PRESETS,
  PRESETS,
  RADII,
  STORAGE_KEY,
  TINTS,
  adoptAppearance,
  appearanceSender,
  forgetAppearance,
  keepWithAccount,
  keptAppearance,
} from './appearance.ts';
import { APPEARANCE_CHOICES, readAppearanceChoice } from '../../worker/src/appearance.ts';

/**
 * The appearance kept with the account (FRU-716): the worker takes every choice of this console and
 * nothing else, the console writes the choice of the account in this browser at each `/console/me`,
 * and the choice of one account never stays for another one.
 */

function browser() {
  const kept = new Map<string, string>();
  const storage = {
    getItem: (key: string) => kept.get(key) ?? null,
    setItem: (key: string, value: string) => void kept.set(key, value),
    removeItem: (key: string) => void kept.delete(key),
  };
  const style = new Map<string, string>();
  const root = {
    style: {
      setProperty: (name: string, value: string | null) => void style.set(name, value ?? ''),
      removeProperty: (name: string) => {
        style.delete(name);
        return '';
      },
    },
  };

  return { kept, storage, style, root };
}

const ALICE: Appearance = { ...DEFAULT_APPEARANCE, mode: 'dark', dark: 'graphite', accent: 'teal' };

describe('the values of an appearance, in the console and in the worker (FRU-716)', () => {
  it('are the same lists', () => {
    assert.deepEqual(APPEARANCE_CHOICES, {
      mode: ['light', 'dark', 'system'],
      light: LIGHT_PRESETS,
      dark: DARK_PRESETS,
      sidebar: TINTS,
      accent: ACCENT_IDS,
      density: ['compact', 'default', 'comfortable'],
      radius: RADII,
      fontSize: FONT_SIZES,
    });
    assert.deepEqual(Object.keys(APPEARANCE_CHOICES).sort(), Object.keys(DEFAULT_APPEARANCE).sort());
  });

  it('the worker takes the default and every theme of the console', () => {
    assert.deepEqual(readAppearanceChoice(DEFAULT_APPEARANCE), DEFAULT_APPEARANCE);
    for (const preset of Object.keys(PRESETS) as (keyof typeof PRESETS)[]) {
      const scheme = PRESETS[preset].scheme;
      const chosen = { ...DEFAULT_APPEARANCE, [scheme]: preset, mode: scheme };
      assert.deepEqual(readAppearanceChoice(chosen), chosen, preset);
    }
  });
});

describe('the appearance of the account in this browser (FRU-716)', () => {
  it('writes the choice of the account on the page and in this browser, for public/appearance.js', () => {
    const { kept, storage, style, root } = browser();
    adoptAppearance({ appearance: ALICE }, root, storage, false);

    assert.deepEqual(keptAppearance(storage), ALICE);
    assert.equal(style.get('--color-page'), PRESETS.graphite.page);
    assert.equal(JSON.parse(kept.get(STORAGE_KEY) as string).dark['--color-page'], PRESETS.graphite.page);
  });

  it('takes the choice of another account away when this account has none', () => {
    const { kept, storage, style, root } = browser();
    adoptAppearance({ appearance: ALICE }, root, storage, false);
    adoptAppearance({}, root, storage, false);

    assert.equal(kept.size, 0);
    assert.equal(style.size, 0);
    assert.deepEqual(keptAppearance(storage), DEFAULT_APPEARANCE);
  });

  it('reads a value it does not know field by field: the default in its place', () => {
    const { storage, root } = browser();
    adoptAppearance({ appearance: { ...ALICE, dark: 'dusk', accent: 42, more: true } }, root, storage, false);

    assert.deepEqual(keptAppearance(storage), { ...ALICE, dark: DEFAULT_APPEARANCE.dark, accent: 'red' });
    adoptAppearance({ appearance: 'dark' }, root, storage, false);
    assert.deepEqual(keptAppearance(storage), DEFAULT_APPEARANCE);
  });

  it('writes nothing when this browser already holds the choice of the account', () => {
    const { storage, root } = browser();
    adoptAppearance({ appearance: ALICE }, root, storage, false);
    let writes = 0;
    const counted = { ...storage, setItem: (key: string, value: string) => (writes++, storage.setItem(key, value)) };
    adoptAppearance({ appearance: ALICE }, root, counted, false);
    adoptAppearance({}, root, { ...counted, removeItem: () => void writes++ }, true);

    assert.equal(writes, 1, 'only the change to the default wrote');
  });

  it('a sign-out takes the choice away, for the next person of this browser', () => {
    const { kept, storage, style, root } = browser();
    adoptAppearance({ appearance: ALICE }, root, storage, false);
    forgetAppearance(root, storage);

    assert.equal(kept.size, 0);
    assert.equal(style.size, 0);
  });

  it('a sign-out outside a page, with no storage, throws nothing', () => {
    assert.doesNotThrow(() => forgetAppearance(undefined, undefined));
  });
});

describe('the choices sent to the account (FRU-716)', () => {
  it('sends one request at a time, then only the last choice made meanwhile, and the default as null', async () => {
    const sent: (Appearance | null)[] = [];
    const answers: ((heard: boolean) => void)[] = [];
    const sender = appearanceSender((appearance) => {
      sent.push(appearance);
      return new Promise((resolve) => answers.push(resolve));
    });
    const first = sender.send(ALICE);
    const second = sender.send({ ...ALICE, accent: 'blue' });
    const third = sender.send(DEFAULT_APPEARANCE);
    assert.equal(sender.busy(), true);
    assert.deepEqual(sent, [ALICE]);

    answers[0]?.(true);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(sent, [ALICE, null]);
    answers[1]?.(true);

    assert.deepEqual(await Promise.all([first, second, third]), [true, true, true]);
    assert.equal(sender.busy(), false);
  });

  it('a sign-out drops the choice that waits: it never leaves with the cookie of the next person', async () => {
    const sent: (Appearance | null)[] = [];
    let answer: () => void = () => {};
    // The first request waits for `answer`; any later one is answered at once.
    const save = (appearance: Appearance | null) => {
      sent.push(appearance);
      return sent.length === 1
        ? new Promise<boolean>((resolve) => (answer = () => resolve(true)))
        : Promise.resolve(true);
    };
    const first = keepWithAccount(ALICE, save);
    // Pressed while the first one is on its way: it waits.
    const second = keepWithAccount({ ...ALICE, accent: 'blue' }, save);
    forgetAppearance(undefined, undefined);
    answer();

    await Promise.all([first, second]);
    assert.deepEqual(sent, [ALICE]);
  });

  it('after a sign-out, a request still on its way does not stop the next person from getting their own choice', async () => {
    const { storage, root } = browser();
    let answer: () => void = () => {};
    const save = () => new Promise<boolean>((resolve) => (answer = () => resolve(true)));
    const ana = keepWithAccount(ALICE, save);
    forgetAppearance(root, storage);
    // Ben signs in, in this tab, before the request of Ana is answered.
    const ben: Appearance = { ...DEFAULT_APPEARANCE, mode: 'dark', dark: 'midnight', accent: 'indigo' };
    adoptAppearance({ appearance: ben }, root, storage, false);

    assert.deepEqual(keptAppearance(storage), ben);
    answer();
    await ana;
  });

  it('a choice of the next person made while the request of before flies is busy again, and answered by its own request', async () => {
    const sent: (Appearance | null)[] = [];
    const answers: ((heard: boolean) => void)[] = [];
    const save = (appearance: Appearance | null) => {
      sent.push(appearance);
      return new Promise<boolean>((resolve) => answers.push(resolve));
    };
    const sender = appearanceSender(save);
    void sender.send(ALICE);
    sender.drop();
    assert.equal(sender.busy(), false);
    const ben: Appearance = { ...DEFAULT_APPEARANCE, accent: 'indigo' };
    const his = sender.send(ben);
    assert.equal(sender.busy(), true, 'an older /console/me would draw over the choice of Ben');
    // The request of before fails late: the answer Ben gets is the one of his own request.
    answers[0]?.(false);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(sent, [ALICE, ben]);
    answers[1]?.(true);
    assert.equal(await his, true);
  });

  it('says that the account did not take the last choice: a refusal, or no answer', async () => {
    const refused = appearanceSender(async () => false);
    assert.equal(await refused.send(ALICE), false);
    const unreachable = appearanceSender(() => Promise.reject(new Error('offline')));
    assert.equal(await unreachable.send(ALICE), false);
  });
});
