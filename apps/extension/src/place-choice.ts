import type { PlaceIds, Source, SourceOffer } from './cloud.ts';
import { t } from './i18n.ts';
import { dropMark } from './kit.ts';

/**
 * « Notes go to » on screen 2 of the popup (FRU-453, review of Mathieu): three lists in a row, as the
 * console chooses a place (FRU-458). The provider first, with its mark beside its name; then the team
 * of a Linear, or the repository of a GitHub; then a project of the team, which may be none.
 *
 * Each list is a native `select`, so the keyboard and a screen reader work as everywhere. Its marks
 * are drawn by Chromium's customizable select (`appearance: base-select`, `style.css`). A browser
 * without it shows the names alone.
 *
 * Nothing here binds `browser`: the entrypoint gives what reads the teams and what writes the place,
 * and `place-choice.test.ts` reads it on happy-dom.
 */

const SVG = 'http://www.w3.org/2000/svg';

/**
 * The marks of the sources, in boxes of 24 and 16 (the console's `connector-marks.tsx`):
 * - Linear: the logo of Linear, from simple-icons 15.0.0 (`icons/linear.svg`, CC0-1.0);
 * - GitHub: the mark of GitHub's logo guidelines, the `mark-github` of Octicons (MIT);
 * - an address: two braces, drawn as lines.
 */
const LINEAR_MARK =
  'M2.886 4.18A11.982 11.982 0 0 1 11.99 0C18.624 0 24 5.376 24 12.009c0 3.64-1.62 6.903-4.18 9.105L2.887 4.18ZM1.817 5.626l16.556 16.556c-.524.33-1.075.62-1.65.866L.951 7.277c.247-.575.537-1.126.866-1.65ZM.322 9.163l14.515 14.515c-.71.172-1.443.282-2.195.322L0 11.358a12 12 0 0 1 .322-2.195Zm-.17 4.862 9.823 9.824a12.02 12.02 0 0 1-9.824-9.824Z';
const GITHUB_MARK =
  'M8 0c4.42 0 8 3.58 8 8a8.013 8.013 0 0 1-5.45 7.59c-.4.08-.55-.17-.55-.38 0-.27.01-1.13.01-2.2 0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15.08-.2.36-1.02-.08-2.12 0 0-.67-.22-2.2.82-.64-.18-1.32-.27-2-.27-.68 0-1.36.09-2 .27-1.53-1.03-2.2-.82-2.2-.82-.44 1.1-.16 1.92-.08 2.12-.51.56-.82 1.28-.82 2.15 0 3.06 1.86 3.75 3.64 3.95-.23.2-.44.55-.51 1.07-.46.21-1.61.55-2.33-.66-.15-.24-.6-.83-1.23-.82-.67.01-.27.38.01.53.34.19.73.9.82 1.13.16.45.68 1.31 2.69.94 0 .67.01 1.3.01 1.49 0 .21-.15.45-.55.38A7.995 7.995 0 0 1 0 8c0-4.42 3.58-8 8-8Z';
const BRACES =
  'M6 2.5c-1.5 0-2 .7-2 2v1.8c0 .9-.5 1.5-1.5 1.7 1 .2 1.5.8 1.5 1.7v1.8c0 1.3.5 2 2 2M10 2.5c1.5 0 2 .7 2 2v1.8c0 .9.5 1.5 1.5 1.7-1 .2-1.5.8-1.5 1.7v1.8c0 1.3-.5 2-2 2';

/** The mark of a kind of source, which a screen reader skips: the name beside it says the kind. */
export function sourceMark(document: Document, kind: Source['kind']): SVGSVGElement {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', kind === 'linear' ? '0 0 24 24' : '0 0 16 16');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.setAttribute('class', 'source-mark');
  svg.dataset.kind = kind;
  const path = document.createElementNS(SVG, 'path');
  if (kind === 'rest') {
    path.setAttribute('d', BRACES);
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', 'currentColor');
    path.setAttribute('stroke-width', '1.5');
    path.setAttribute('stroke-linecap', 'round');
  } else {
    path.setAttribute('d', kind === 'linear' ? LINEAR_MARK : GITHUB_MARK);
    path.setAttribute('fill', 'currentColor');
  }
  svg.append(path);

  return svg;
}

/** The value of « Fruitback » in the list of the providers: no place, the notes stay here. */
const NO_PLACE = '';
/** A value no person chooses: « Not known », « Choose a team… », « Loading… ». */
const NOTHING = 'nothing';

export type PlaceChoiceOptions = {
  /** The sources of the workspace chosen now. */
  sources: () => Source[];
  /** Where the notes go now: `null` for « Fruitback », absent when the worker did not say. */
  place?: PlaceIds | null;
  /** The teams of a Linear or the repositories of a GitHub; `undefined` when they did not come. */
  loadOffer: (connector: string) => Promise<SourceOffer | undefined>;
  /** Answers whether the place holds: `false` draws the lists again at the place of before. */
  onPlace: (place: PlaceIds | null) => Promise<boolean>;
};

export type PlaceChoice = {
  /** The lines of the list of facts: the provider, then the team, then the project. */
  entries: HTMLElement[];
  /** Another workspace: its sources, and « Fruitback » chosen. */
  reset: () => void;
};

/**
 * An option whose words are in a `span`: the field of a customizable select copies them, and cuts them
 * with « … » when they are long (`style.css`).
 */
export function option(document: Document, value: string, label: string, disabled = false): HTMLOptionElement {
  const node = document.createElement('option');
  node.value = value;
  const words = document.createElement('span');
  words.className = 'choice-label';
  words.textContent = label;
  node.append(words);
  node.disabled = disabled;

  return node;
}

/**
 * The field of a customizable select: a `button` whose `selectedcontent` shows the option chosen, its
 * mark with it. A browser without it draws neither, and shows the words of the option.
 */
export function shownChoice(document: Document): HTMLButtonElement {
  const shown = document.createElement('button');
  shown.append(document.createElement('selectedcontent'));

  return shown;
}

/** The options of a list, after its field. */
function fill(select: HTMLSelectElement, ...nodes: HTMLOptionElement[]): void {
  select.replaceChildren(shownChoice(select.ownerDocument), ...nodes);
}

function line(document: Document, term: string, select: HTMLSelectElement): HTMLElement {
  const entry = document.createElement('div');
  entry.className = 'kit-dl-entry';
  const dt = document.createElement('dt');
  dt.textContent = term;
  const dd = document.createElement('dd');
  dd.append(select);
  entry.append(dt, dd);

  return entry;
}

export function placeChoice(document: Document, options: PlaceChoiceOptions): PlaceChoice {
  const provider = document.createElement('select');
  provider.name = 'provider';
  provider.setAttribute('aria-label', t('Notes go to'));
  const team = document.createElement('select');
  team.name = 'team';
  team.setAttribute('aria-label', t('Team'));
  const project = document.createElement('select');
  project.name = 'project';
  project.setAttribute('aria-label', t('Project'));
  const providerLine = line(document, t('Notes go to'), provider);
  const teamTerm = document.createElement('dt');
  const teamLine = line(document, '', team);
  teamLine.querySelector('dt')?.replaceWith(teamTerm);
  const projectLine = line(document, t('Project'), project);

  /** The place the worker holds now, as far as this screen knows. */
  let saved = options.place;
  /** The offer of the provider shown, once it came. */
  let offer: SourceOffer | undefined;
  /** Which drawing the lists are: an offer that comes after another drawing is dropped. */
  let drawing = 0;

  const sourceOf = (id: string) => options.sources().find((each) => each.id === id);

  function fillProviders(current: PlaceIds | null | undefined): void {
    const none = option(document, NO_PLACE, t('Fruitback (no tracker)'));
    const drop = dropMark(document, 'source-mark');
    drop.dataset.kind = 'fruitback';
    none.prepend(drop);
    fill(provider, none);
    for (const source of options.sources()) {
      const each = option(document, source.id, source.label);
      each.prepend(sourceMark(document, source.kind));
      provider.append(each);
    }
    if (current === undefined) {
      provider.append(option(document, NOTHING, t('Not known'), true));
      provider.value = NOTHING;
    } else if (current === null) provider.value = NO_PLACE;
    else if (sourceOf(current.connector) !== undefined) provider.value = current.connector;
    else {
      provider.append(option(document, NOTHING, t('Not known'), true));
      provider.value = NOTHING;
    }
  }

  function fillProjects(current: PlaceIds | undefined): void {
    const chosen = offer?.kind === 'linear' ? offer.teams.find((each) => each.id === team.value) : undefined;
    fill(project, option(document, NO_PLACE, t('No project')));
    for (const each of chosen?.projects ?? []) project.append(option(document, each.id, each.name));
    project.value =
      current?.projectId !== undefined && chosen?.projects.some((each) => each.id === current.projectId) === true
        ? current.projectId
        : NO_PLACE;
    projectLine.hidden = chosen === undefined || chosen.projects.length === 0;
  }

  /** The team and the project of the provider chosen, read from its tracker. */
  async function fillTeams(connector: string, current: PlaceIds | undefined): Promise<void> {
    const kind = sourceOf(connector)?.kind;
    projectLine.hidden = true;
    offer = undefined;
    if (kind !== 'linear' && kind !== 'github') {
      teamLine.hidden = true;

      return;
    }
    const thisDrawing = ++drawing;
    const term = kind === 'linear' ? t('Team') : t('Repository');
    teamTerm.textContent = term;
    team.setAttribute('aria-label', term);
    fill(team, option(document, NOTHING, t('Loading…'), true));
    team.value = NOTHING;
    team.disabled = true;
    teamLine.hidden = false;
    const read = await options.loadOffer(connector).catch(() => undefined);
    if (thisDrawing !== drawing) return;
    team.disabled = false;
    if (read === undefined || read.kind === 'rest') {
      fill(team, option(document, NOTHING, t('The list did not load. Choose the provider again.'), true));
      team.value = NOTHING;

      return;
    }
    offer = read;
    const choices =
      read.kind === 'linear'
        ? read.teams.map((each) => ({
            value: each.id,
            label: each.key === '' ? each.name : `${each.name} (${each.key})`,
          }))
        : read.repositories.map((each) => ({ value: each.fullName, label: each.fullName }));
    fill(
      team,
      option(document, NOTHING, kind === 'linear' ? t('Choose a team…') : t('Choose a repository…'), true),
      ...choices.map((each) => option(document, each.value, each.label)),
    );
    team.value =
      current?.teamId !== undefined && choices.some((each) => each.value === current.teamId) ? current.teamId : NOTHING;
    if (read.kind === 'linear' && team.value !== NOTHING) fillProjects(current);
  }

  /** The lists at `place`: what the worker holds, or what was just chosen. */
  function draw(place: PlaceIds | null | undefined): void {
    fillProviders(place);
    void fillTeams(place === null || place === undefined ? '' : place.connector, place ?? undefined);
  }

  const lists = [provider, team, project];
  /** Writes a place; a refusal draws the lists again at the place of before. */
  async function commit(place: PlaceIds | null): Promise<void> {
    for (const each of lists) each.disabled = true;
    const holds = await options.onPlace(place).catch(() => false);
    for (const each of lists) each.disabled = false;
    if (holds) saved = place;
    else draw(saved);
  }

  provider.addEventListener('change', () => {
    const chosen = provider.value;
    if (chosen === NO_PLACE) {
      teamLine.hidden = true;
      projectLine.hidden = true;
      drawing += 1;
      void commit(null);

      return;
    }
    const kind = sourceOf(chosen)?.kind;
    // An address has nothing more to choose; a Linear or a GitHub waits for its team.
    if (kind === 'rest') {
      teamLine.hidden = true;
      projectLine.hidden = true;
      drawing += 1;
      void commit({ connector: chosen });

      return;
    }
    void fillTeams(chosen, undefined);
  });
  team.addEventListener('change', () => {
    if (team.value === NOTHING) return;
    if (offer?.kind === 'linear') fillProjects(undefined);
    void commit({ connector: provider.value, teamId: team.value });
  });
  project.addEventListener('change', () => {
    void commit({
      connector: provider.value,
      teamId: team.value,
      ...(project.value === NO_PLACE ? {} : { projectId: project.value }),
    });
  });

  draw(saved);

  return {
    entries: [providerLine, teamLine, projectLine],
    reset: () => {
      saved = null;
      drawing += 1;
      draw(null);
      void options.onPlace(null);
    },
  };
}
