import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Window as HappyDomWindow } from 'happy-dom';
import type { PlaceIds, Source, SourceOffer } from './cloud.ts';
import { setLanguage } from './i18n.ts';
import { placeChoice } from './place-choice.ts';

/**
 * « Notes go to » in three lists (FRU-453, review of Mathieu): the provider with its mark, then the
 * team or the repository, then the project, each drawn again when the one before changes.
 */

function page(): Document {
  return new HappyDomWindow({ url: 'chrome-extension://fruitback/popup.html' }).document as unknown as Document;
}

const SOURCES: Source[] = [
  { id: 'lin', kind: 'linear', label: 'Linear · Acme' },
  { id: 'gh', kind: 'github', label: 'GitHub · acme' },
  { id: 'hook', kind: 'rest', label: 'REST API · Hook' },
];
const LINEAR: SourceOffer = {
  kind: 'linear',
  teams: [
    { id: 'design', name: 'Design', key: 'DES', projects: [{ id: 'site', name: 'Site' }] },
    { id: 'support', name: 'Support', key: 'SUP', projects: [] },
  ],
};
const GITHUB: SourceOffer = { kind: 'github', repositories: [{ fullName: 'acme/web' }] };
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function choose(select: HTMLSelectElement, value: string): void {
  select.value = value;
  select.dispatchEvent(new (select.ownerDocument.defaultView as unknown as typeof globalThis).Event('change'));
}

function mount(place: PlaceIds | null | undefined, answers: { holds?: boolean; offer?: SourceOffer } = {}) {
  const document = page();
  const written: (PlaceIds | null)[] = [];
  const loaded: string[] = [];
  const choice = placeChoice(document, {
    sources: () => SOURCES,
    ...(place === undefined ? {} : { place }),
    loadOffer: async (connector) => {
      loaded.push(connector);
      if (answers.offer !== undefined) return answers.offer;

      if (connector === 'lin') return LINEAR;

      return connector === 'gh' ? GITHUB : { kind: 'rest' };
    },
    onPlace: async (chosen) => {
      written.push(chosen);

      return answers.holds ?? true;
    },
  });
  const list = document.createElement('dl');
  list.append(...choice.entries);
  document.body.append(list);
  const select = (name: string) => list.querySelector<HTMLSelectElement>(`select[name="${name}"]`) as HTMLSelectElement;
  const shown = (name: string) => !(select(name).closest('.kit-dl-entry') as HTMLElement).hidden;

  return { choice, list, select, shown, written, loaded };
}

describe('the three lists of « Notes go to » (FRU-453)', () => {
  it('starts at the place of the site: provider, team and project, each with its own name', async () => {
    const { select, shown, loaded } = mount({ connector: 'lin', teamId: 'design', projectId: 'site' });
    await settle();

    assert.deepEqual(
      [...select('provider').options].map((option) => [option.value, option.textContent]),
      [
        ['', 'Fruitback (no tracker)'],
        ['lin', 'Linear · Acme'],
        ['gh', 'GitHub · acme'],
        ['hook', 'REST API · Hook'],
      ],
    );
    assert.equal(select('provider').value, 'lin');
    assert.equal(select('provider').getAttribute('aria-label'), 'Notes go to');
    assert.deepEqual(loaded, ['lin']);
    assert.equal(select('team').getAttribute('aria-label'), 'Team');
    assert.equal(select('team').value, 'design');
    assert.equal(select('project').value, 'site');
    assert.equal(shown('team'), true);
    assert.equal(shown('project'), true);
  });

  it('draws the mark of each provider beside its name, and a screen reader skips it', () => {
    const { select } = mount(null);
    const marks = [...select('provider').options].map((option) => option.querySelector('svg'));

    assert.deepEqual(
      marks.map((mark) => mark?.getAttribute('aria-hidden')),
      ['true', 'true', 'true', 'true'],
    );
    assert.deepEqual(
      marks.slice(1).map((mark) => mark?.getAttribute('data-kind')),
      ['linear', 'github', 'rest'],
    );
  });

  it('writes nothing for a Linear until a team is chosen, then the team, then the project', async () => {
    const { select, shown, written } = mount(null);
    assert.equal(shown('team'), false);

    choose(select('provider'), 'lin');
    assert.equal(select('team').disabled, true, 'the teams load');
    await settle();
    assert.equal(shown('team'), true);
    assert.equal(select('team').selectedOptions[0]?.textContent, 'Choose a team…');
    assert.deepEqual(written, []);

    choose(select('team'), 'design');
    await settle();
    assert.equal(shown('project'), true);
    assert.deepEqual(
      [...select('project').options].map((option) => option.textContent),
      ['No project', 'Site'],
    );
    choose(select('project'), 'site');
    await settle();
    choose(select('project'), '');
    await settle();
    // A team with no project has no third list.
    choose(select('team'), 'support');
    await settle();
    assert.equal(shown('project'), false);

    assert.deepEqual(written, [
      { connector: 'lin', teamId: 'design' },
      { connector: 'lin', teamId: 'design', projectId: 'site' },
      { connector: 'lin', teamId: 'design' },
      { connector: 'lin', teamId: 'support' },
    ]);
  });

  it('a GitHub asks for its repository; an address and « Fruitback » are written at once', async () => {
    const { select, shown, written } = mount(null);

    choose(select('provider'), 'gh');
    await settle();
    assert.equal(select('team').getAttribute('aria-label'), 'Repository');
    choose(select('team'), 'acme/web');
    await settle();
    assert.equal(shown('project'), false);
    choose(select('provider'), 'hook');
    await settle();
    assert.equal(shown('team'), false);
    choose(select('provider'), '');
    await settle();

    assert.deepEqual(written, [{ connector: 'gh', teamId: 'acme/web' }, { connector: 'hook' }, null]);
  });

  it('goes back to the place of before when the worker refuses', async () => {
    const { select, shown, written } = mount({ connector: 'hook' }, { holds: false });
    await settle();

    choose(select('provider'), '');
    await settle();
    await settle();
    assert.deepEqual(written, [null]);
    assert.equal(select('provider').value, 'hook');
    assert.equal(shown('team'), false);
    assert.equal(select('provider').disabled, false);
  });

  it('says a place it does not know as « Not known », and a list that did not come', async () => {
    const unknown = mount(undefined);
    assert.equal(unknown.select('provider').selectedOptions[0]?.textContent, 'Not known');
    assert.equal(unknown.select('provider').selectedOptions[0]?.disabled, true);

    const silent = mount(null, { offer: undefined });
    const failing = placeChoice(page(), {
      sources: () => SOURCES,
      place: null,
      loadOffer: async () => undefined,
      onPlace: async () => true,
    });
    const provider = failing.entries[0]?.querySelector('select') as HTMLSelectElement;
    const team = failing.entries[1]?.querySelector('select') as HTMLSelectElement;
    choose(provider, 'lin');
    await settle();
    assert.equal(team.selectedOptions[0]?.textContent, 'The list did not load. Choose the provider again.');
    assert.equal(silent.written.length, 0);
  });

  it('drops the teams of a provider left before they came', async () => {
    let release: (offer: SourceOffer) => void = () => undefined;
    const document = page();
    const choice = placeChoice(document, {
      sources: () => SOURCES,
      place: null,
      loadOffer: (connector) =>
        connector === 'lin' ? new Promise((resolve) => (release = resolve)) : Promise.resolve(GITHUB),
      onPlace: async () => true,
    });
    const [provider, team] = choice.entries.map((entry) => entry.querySelector('select') as HTMLSelectElement);
    if (provider === undefined || team === undefined) throw new Error('no lists');
    choose(provider, 'lin');
    choose(provider, 'gh');
    await settle();
    release(LINEAR);
    await settle();
    assert.deepEqual(
      [...team.options].map((option) => option.value),
      ['nothing', 'acme/web'],
    );
  });

  it('speaks French', async () => {
    setLanguage('fr');
    try {
      const { select } = mount(null);
      choose(select('provider'), 'lin');
      await settle();
      assert.equal(select('provider').options[0]?.textContent, 'Fruitback (sans outil de suivi)');
      assert.equal(select('team').getAttribute('aria-label'), 'Équipe');
      assert.equal(select('team').selectedOptions[0]?.textContent, 'Choisir une équipe…');
    } finally {
      setLanguage('en');
    }
  });
});
