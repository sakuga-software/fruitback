import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Window as HappyDomWindow } from 'happy-dom';
import { setLanguage } from './i18n.ts';
import type { PlaceIds, SourceOffer } from './cloud.ts';
import { changeNotice, destinationScreen } from './destination-screen.ts';

afterEach(() => setLanguage('en'));

function page(): Document {
  return new HappyDomWindow({ url: 'chrome-extension://fruitback/popup.html' }).document as unknown as Document;
}

const settled = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
const LINEAR = { id: 'lin', kind: 'linear' as const, label: 'Linear · Acme' };
const GITHUB = { id: 'gh', kind: 'github' as const, label: 'GitHub · acme-org' };
const OFFERS: Record<string, SourceOffer> = {
  lin: {
    kind: 'linear',
    teams: [{ id: 't1', name: 'Acme web', key: 'WEB', projects: [{ id: 'p1', name: 'Website' }] }],
  },
  gh: { kind: 'github', repositories: [{ fullName: 'acme-org/site' }] },
};

function screen(extra: Partial<Parameters<typeof destinationScreen>[1]> = {}, calls: unknown[] = []) {
  const document = page();
  const root = destinationScreen(document, {
    host: 'staging.acme.dev',
    workspace: 'Acme',
    sources: [LINEAR, GITHUB],
    place: { connector: 'lin', teamId: 't1', projectId: 'p1' },
    loadOffer: async (connector) => OFFERS[connector],
    onSave: async (place, said) => {
      calls.push({ place, said });

      return true;
    },
    onBack: () => calls.push('back'),
    onConnect: () => calls.push('connect'),
    copy: async (text) => {
      calls.push({ copied: text });

      return true;
    },
    ...extra,
  });
  document.body.append(root);

  return root;
}

const pick = (root: HTMLElement, value: string): void => {
  const input = root.querySelector<HTMLInputElement>(`input[type="radio"][value="${value}"]`) as HTMLInputElement;
  input.checked = true;
  input.dispatchEvent(new (root.ownerDocument.defaultView as unknown as typeof globalThis).Event('change'));
};
const select = (root: HTMLElement, name: string, value: string): void => {
  const node = root.querySelector<HTMLSelectElement>(`select[name="${name}"]`) as HTMLSelectElement;
  node.value = value;
  node.dispatchEvent(new (root.ownerDocument.defaultView as unknown as typeof globalThis).Event('change'));
};

describe('« Where notes go », a screen of the popup (FRU-600)', () => {
  it('has a card for Fruitback and for each source, the one of the place chosen, with its lists under it', async () => {
    const root = screen();
    await settled();

    assert.equal(root.querySelector('h1')?.textContent, 'Where notes go');
    assert.equal(root.querySelector('[role="radiogroup"]')?.getAttribute('aria-label'), 'Where notes go');
    assert.deepEqual(
      [...root.querySelectorAll('.destination-card-name')].map((name) => name.textContent),
      ['Fruitback', 'Linear', 'GitHub'],
    );
    assert.deepEqual(
      [...root.querySelectorAll('.destination-card-detail')].map((detail) => detail.textContent),
      ['No tracker, the notes stay here', 'Connected · Acme', 'Connected · acme-org'],
    );
    const chosen = root.querySelector('.destination-card.is-chosen');
    assert.equal(chosen?.querySelector('.destination-card-name')?.textContent, 'Linear');
    assert.ok(chosen?.querySelector('.destination-lists') !== null);
    assert.equal(root.querySelector<HTMLSelectElement>('select[name="team"]')?.value, 't1');
    assert.equal(root.querySelector<HTMLSelectElement>('select[name="project"]')?.value, 'p1');
    assert.equal(root.querySelector('.destination-kept')?.textContent, 'Notes already sent stay where they are.');
  });

  it('writes nothing before « Save », then the place, and says it in words', async () => {
    const calls: unknown[] = [];
    const root = screen({}, calls);
    await settled();
    pick(root, 'gh');
    await settled();
    // A GitHub waits for its repository: « Save » waits too.
    assert.equal(root.querySelector<HTMLButtonElement>('.kit-primary')?.disabled, true);
    select(root, 'team', 'acme-org/site');
    assert.deepEqual(calls, []);
    root.querySelector<HTMLButtonElement>('.kit-primary')?.click();
    await settled();
    assert.deepEqual(calls, [{ place: { connector: 'gh', teamId: 'acme-org/site' }, said: 'GitHub / acme-org/site' }]);
    // Screen 3 did not replace this screen: it says the save itself, and « Save » works again.
    assert.equal(root.querySelector('.destination-saved')?.textContent, 'New notes now go to GitHub / acme-org/site');
    assert.equal(root.querySelector('.problem')?.textContent, '');
    assert.equal(root.querySelector<HTMLButtonElement>('.kit-primary')?.disabled, false);
  });

  it('saves « Fruitback » with no place, and keeps the screen with a problem when the worker refuses', async () => {
    const calls: unknown[] = [];
    const root = screen({ onSave: async (place: PlaceIds | null) => (calls.push(place), false) }, calls);
    await settled();
    pick(root, '');
    assert.equal(
      root.querySelector('.destination-lists')?.closest('.destination-card')?.querySelector('input')?.value,
      '',
    );
    root.querySelector<HTMLButtonElement>('.kit-primary')?.click();
    await settled();
    assert.deepEqual(calls, [null]);
    assert.equal(root.querySelector('.problem')?.textContent, 'The place could not be saved. Try again.');
    assert.equal(root.querySelector<HTMLButtonElement>('.kit-primary')?.disabled, false);
    assert.equal(root.querySelector('.destination-saved')?.textContent, '');
  });

  it('goes back with « Back » and « Cancel », and opens the console for another tool', () => {
    const calls: unknown[] = [];
    const root = screen({}, calls);
    root.querySelector<HTMLButtonElement>('.destination-back')?.click();
    root.querySelector<HTMLButtonElement>('.destination-actions .kit-secondary')?.click();
    root.querySelector<HTMLButtonElement>('.destination-connect')?.click();
    assert.deepEqual(calls, ['back', 'back', 'connect']);
    assert.equal(screen({ onConnect: undefined }).querySelector('.destination-connect'), null);
  });

  it('is locked for a role that may not change it, with a message to copy for an admin', async () => {
    const calls: unknown[] = [];
    const root = screen({ sources: undefined, label: 'Linear · Acme web', kind: 'linear' }, calls);
    assert.equal(root.querySelector('[role="radiogroup"]'), null);
    assert.equal(root.querySelector('.destination-locked .destination-card-name')?.textContent, 'Acme web');
    assert.ok(root.querySelector('.destination-lock') !== null);
    assert.equal(
      root.querySelector('.destination-why')?.textContent,
      'Only an owner or an admin of Acme can change where the notes of this site go.',
    );
    root.querySelector<HTMLButtonElement>('.kit-secondary:not(.destination-back)')?.click();
    await settled();
    assert.deepEqual(calls, [
      { copied: 'Could you change where the notes of staging.acme.dev go, in the Acme workspace of Fruitback?' },
    ]);
    assert.equal(root.querySelector('.destination-copied')?.textContent, 'Copied');
  });

  it('reads the provider of a locked place from its label, as screen 3 does, when the worker names no kind', () => {
    const root = screen({ sources: undefined, label: 'Linear · Northwind', kind: undefined });
    assert.equal(root.querySelector('.destination-locked svg')?.getAttribute('data-kind'), 'linear');
    assert.equal(root.querySelector('.destination-locked .destination-card-name')?.textContent, 'Northwind');
    assert.equal(root.querySelector('.destination-locked .destination-card-detail')?.textContent, 'Linear');
  });

  it('speaks French', () => {
    setLanguage('fr');
    const root = screen();
    assert.equal(root.querySelector('h1')?.textContent, 'Destination des notes');
    assert.equal(root.querySelector('.kit-primary')?.textContent, 'Enregistrer');
  });
});

describe('the confirmation of a change on screen 3 (FRU-600)', () => {
  it('says what changed, leaves after its time, and holds while the pointer is over it', async () => {
    const document = page();
    const notice = changeNotice(document, 'New notes now go to GitHub / acme-org/site', 30);
    document.body.append(notice);
    assert.equal(notice.getAttribute('role'), 'status');
    assert.equal(notice.textContent, 'New notes now go to GitHub / acme-org/site');
    const view = document.defaultView as unknown as typeof globalThis;
    notice.dispatchEvent(new view.Event('pointerenter'));
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.ok(notice.isConnected, 'it left while the pointer held it');
    notice.dispatchEvent(new view.Event('pointerleave'));
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(notice.isConnected, false);
  });
});
