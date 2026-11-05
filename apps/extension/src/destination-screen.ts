import type { DestinationKind, PlaceIds, Source, SourceOffer } from './cloud.ts';
import { t } from './i18n.ts';
import { button, dropMark, make, primaryButton, secondaryButton } from './kit.ts';
import { option, shownChoice, sourceMark } from './place-choice.ts';
import { BACK, CHECK, LOCK, drawIcon } from './popup-icons.ts';
import { readDestination } from './popup-view.ts';

/**
 * « Where notes go », a screen of the popup of its own (P1b of FRU-598, FRU-600): opened by the pencil
 * of « Sent to » and by « Change where notes go » of the menu « ⋯ ».
 *
 * - A role that may change the place chooses a card for each source of the workspace, then the team
 *   and the project of a Linear, or the repository of a GitHub, under the card chosen. Nothing is
 *   written before « Save »: the lists of screen 2 (`placeChoice`) write at each change.
 * - A role that may not reads the place, locked, and copies a message for an admin.
 *
 * Nothing here binds `browser`: the entrypoint gives what reads the teams, what writes the place and
 * what copies, and `destination-screen.test.ts` reads it on happy-dom.
 */

/** The value of the card « Fruitback »: no tracker, the notes stay in Fruitback. */
const FRUITBACK = '';
/** A value no person chooses: « Choose a team… », « Loading… ». */
const NOTHING = 'nothing';

export type DestinationScreenOptions = {
  host: string;
  workspace: string;
  /** The sources of the workspace. Absent: the role may not change the place, and reads it locked. */
  sources?: Source[];
  /** Where the notes go now: `null` for Fruitback, absent when the worker did not say. */
  place?: PlaceIds | null;
  /** « Linear · Acme web », as the worker writes it, for the locked screen. */
  label?: string;
  kind?: DestinationKind;
  loadOffer: (connector: string) => Promise<SourceOffer | undefined>;
  /** Writes the place. `true`: it holds, and the popup goes back with what changed. */
  onSave: (place: PlaceIds | null, said: string) => Promise<boolean>;
  onBack: () => void;
  /** Opens the connectors of the workspace in the console. Absent: no console known, no link. */
  onConnect?: () => void;
  /** Copies a text. `false`: the browser refused. */
  copy: (text: string) => Promise<boolean>;
};

/** The head of the screen: back to screen 3, and its title. */
function head(document: Document, onBack: () => void): HTMLElement {
  const top = make(document, 'div', 'popup-head');
  top.classList.add('destination-head');
  const back = button(document, 'kit-secondary', '', onBack);
  back.classList.add('destination-back');
  back.setAttribute('aria-label', t('Back'));
  back.append(drawIcon(document, BACK));
  top.append(back, make(document, 'h1', 'destination-title', t('Where notes go')));

  return top;
}

/** The mark of a card: the drop of Fruitback, or the mark of the source. */
function markOf(document: Document, kind: Source['kind'] | 'fruitback'): SVGSVGElement {
  if (kind !== 'fruitback') return sourceMark(document, kind);
  const drop = dropMark(document, 'source-mark');
  drop.dataset.kind = 'fruitback';

  return drop;
}

/** A list of the card chosen: its label above it, and a native `select` for the keyboard. */
function field(document: Document, label: string, name: string): { root: HTMLElement; select: HTMLSelectElement } {
  const root = make(document, 'label', 'destination-field');
  root.append(make(document, 'span', 'destination-field-label', label));
  const select = make(document, 'select', '');
  select.name = name;
  root.append(select);

  return { root, select };
}

function fill(select: HTMLSelectElement, ...nodes: HTMLOptionElement[]): void {
  select.replaceChildren(shownChoice(select.ownerDocument), ...nodes);
}

/** « Linear / Acme web / Website »: what the confirmation of screen 3 says. */
function placeWords(source: Source | undefined, offer: SourceOffer | undefined, place: PlaceIds | null): string {
  if (place === null || source === undefined) return 'Fruitback';
  const provider = source.label.split(' · ')[0] ?? source.label;
  if (offer?.kind === 'linear') {
    const team = offer.teams.find((each) => each.id === place.teamId);
    const project = team?.projects.find((each) => each.id === place.projectId);

    return [provider, team?.name, project?.name].filter(Boolean).join(' / ');
  }
  if (offer?.kind === 'github' && place.teamId !== undefined) return `${provider} / ${place.teamId}`;

  return source.label.replace(/ · /g, ' / ');
}

export function destinationScreen(document: Document, options: DestinationScreenOptions): HTMLElement {
  const root = make(document, 'div', 'popup');
  root.classList.add('popup-destination');
  const body = make(document, 'div', 'popup-body');
  root.append(head(document, options.onBack), body);
  if (options.sources === undefined) {
    body.append(...locked(document, options));

    return root;
  }
  const sources = options.sources;

  const intro = make(document, 'p', 'destination-intro');
  intro.append(t('New notes from '), make(document, 'strong', '', options.host));
  const group = make(document, 'div', 'destination-cards');
  group.setAttribute('role', 'radiogroup');
  group.setAttribute('aria-label', t('Where notes go'));
  const problem = make(document, 'p', 'problem');
  problem.setAttribute('role', 'alert');
  const saved = make(document, 'p', 'destination-saved');
  saved.setAttribute('role', 'status');

  const team = field(document, t('Team'), 'team');
  const project = field(document, t('Project'), 'project');
  const lists = make(document, 'div', 'destination-lists');
  lists.append(team.root, project.root);

  let chosen: string = options.place === null || options.place === undefined ? FRUITBACK : options.place.connector;
  let offer: SourceOffer | undefined;
  let drawing = 0;
  const cards = new Map<string, { card: HTMLElement; input: HTMLInputElement }>();
  const save = primaryButton(document, t('Save'));

  const sourceOf = (id: string): Source | undefined => sources.find((each) => each.id === id);

  /** The place the cards and the lists say now, or `undefined` while a list waits for a choice. */
  function placeNow(): PlaceIds | null | undefined {
    if (chosen === FRUITBACK) return null;
    const kind = sourceOf(chosen)?.kind;
    if (kind === 'rest') return { connector: chosen };
    if (team.select.value === NOTHING || team.select.value === '') return undefined;
    if (kind === 'github') return { connector: chosen, teamId: team.select.value };
    const projectId = project.select.value;

    return { connector: chosen, teamId: team.select.value, ...(projectId === '' ? {} : { projectId }) };
  }

  function update(): void {
    save.disabled = placeNow() === undefined;
  }

  function fillProjects(current: PlaceIds | null | undefined): void {
    const picked = offer?.kind === 'linear' ? offer.teams.find((each) => each.id === team.select.value) : undefined;
    fill(project.select, option(document, '', t('No project')));
    for (const each of picked?.projects ?? []) project.select.append(option(document, each.id, each.name));
    const projectId = current?.projectId;
    project.select.value =
      projectId !== undefined && picked?.projects.some((each) => each.id === projectId) === true ? projectId : '';
    project.root.hidden = picked === undefined || picked.projects.length === 0;
  }

  async function fillTeams(current: PlaceIds | null | undefined): Promise<void> {
    const kind = sourceOf(chosen)?.kind;
    offer = undefined;
    project.root.hidden = true;
    if (kind !== 'linear' && kind !== 'github') {
      lists.hidden = true;
      update();

      return;
    }
    const thisDrawing = ++drawing;
    lists.hidden = false;
    team.root.querySelector('.destination-field-label')!.textContent = kind === 'linear' ? t('Team') : t('Repository');
    fill(team.select, option(document, NOTHING, t('Loading…'), true));
    team.select.value = NOTHING;
    team.select.disabled = true;
    update();
    const read = await options.loadOffer(chosen).catch(() => undefined);
    if (thisDrawing !== drawing) return;
    team.select.disabled = false;
    if (read === undefined || read.kind === 'rest') {
      fill(team.select, option(document, NOTHING, t('The list did not load. Choose the provider again.'), true));
      team.select.value = NOTHING;
      update();

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
      team.select,
      option(document, NOTHING, kind === 'linear' ? t('Choose a team…') : t('Choose a repository…'), true),
      ...choices.map((each) => option(document, each.value, each.label)),
    );
    const teamId = current?.teamId;
    team.select.value =
      current?.connector === chosen && teamId !== undefined && choices.some((each) => each.value === teamId)
        ? teamId
        : NOTHING;
    if (read.kind === 'linear' && team.select.value !== NOTHING) fillProjects(current);
    update();
  }

  /** The card chosen holds the lists, under its name. */
  function choose(id: string): void {
    chosen = id;
    for (const [each, { card, input }] of cards) {
      const on = each === id;
      input.checked = on;
      card.classList.toggle('is-chosen', on);
      if (on) card.append(lists);
    }
    void fillTeams(options.place);
  }

  const entries: { id: string; kind: Source['kind'] | 'fruitback'; name: string; detail: string }[] = [
    { id: FRUITBACK, kind: 'fruitback', name: 'Fruitback', detail: t('No tracker, the notes stay here') },
    ...sources.map((source) => {
      const [provider, ...place] = source.label.split(' · ');

      return {
        id: source.id,
        kind: source.kind,
        name: provider ?? source.label,
        detail: place.length === 0 ? t('Connected') : t('Connected · {place}', { place: place.join(' · ') }),
      };
    }),
  ];
  for (const entry of entries) {
    const card = make(document, 'label', 'destination-card');
    const input = make(document, 'input', 'destination-radio');
    input.type = 'radio';
    input.name = 'destination';
    input.value = entry.id;
    input.addEventListener('change', () => {
      if (input.checked) choose(entry.id);
    });
    const line = make(document, 'span', 'destination-card-line');
    const tile = make(document, 'span', 'destination-card-tile');
    tile.append(markOf(document, entry.kind));
    const words = make(document, 'span', 'destination-card-words');
    words.append(
      make(document, 'span', 'destination-card-name', entry.name),
      make(document, 'span', 'destination-card-detail', entry.detail),
    );
    line.append(tile, words, input);
    card.append(line);
    cards.set(entry.id, { card, input });
    group.append(card);
  }
  team.select.addEventListener('change', () => {
    if (offer?.kind === 'linear') fillProjects(undefined);
    update();
  });
  project.select.addEventListener('change', update);

  const foot = make(document, 'div', 'destination-foot');
  foot.append(make(document, 'p', 'destination-kept', t('Notes already sent stay where they are.')));
  const actions = make(document, 'div', 'destination-actions');
  const cancel = secondaryButton(document, t('Cancel'), options.onBack);
  save.addEventListener('click', () => {
    const place = placeNow();
    if (place === undefined) return;
    save.disabled = true;
    problem.textContent = '';
    saved.textContent = '';
    const said = placeWords(place === null ? undefined : sourceOf(place.connector), offer, place);
    void options
      .onSave(place, said)
      .catch(() => false)
      .then((holds) => {
        save.disabled = false;
        // Usually screen 3 replaces this screen. If it is still here, it says the save itself.
        if (holds) saved.textContent = t('New notes now go to {place}', { place: said });
        else problem.textContent = t('The place could not be saved. Try again.');
      });
  });
  actions.append(cancel, save);
  foot.append(actions);

  body.append(intro, group);
  if (options.onConnect !== undefined) {
    const more = button(document, 'link-button', t('+ Connect another tool in the console'), options.onConnect);
    more.classList.add('destination-connect');
    body.append(more);
  }
  body.append(problem, saved, foot);
  choose(cards.has(chosen) ? chosen : FRUITBACK);

  return root;
}

/** A role that may not change the place: it reads it, locked, and copies a message for an admin. */
function locked(document: Document, options: DestinationScreenOptions): Node[] {
  const card = make(document, 'div', 'destination-locked');
  const tile = make(document, 'span', 'destination-card-tile');
  const { kind, provider, place } = readDestination(options.label ?? t('Not known'), options.kind);
  if (kind !== undefined) tile.append(markOf(document, kind));
  const words = make(document, 'span', 'destination-card-words');
  words.append(
    make(document, 'span', 'destination-card-name', place),
    ...(provider === undefined ? [] : [make(document, 'span', 'destination-card-detail', provider)]),
  );
  const lock = drawIcon(document, LOCK);
  lock.classList.add('destination-lock');
  card.append(tile, words, lock);
  const why = make(
    document,
    'p',
    'destination-why',
    t('Only an owner or an admin of {workspace} can change where the notes of this site go.', {
      workspace: options.workspace,
    }),
  );
  const said = make(document, 'p', 'destination-copied');
  said.setAttribute('role', 'status');
  const message = t('Could you change where the notes of {host} go, in the {workspace} workspace of Fruitback?', {
    host: options.host,
    workspace: options.workspace,
  });
  const copy = secondaryButton(document, t('Copy a message for an admin'), () => {
    void options.copy(message).then((copied) => {
      said.textContent = copied ? t('Copied') : message;
    });
  });

  return [card, why, copy, said];
}

/**
 * The confirmation of a change, on screen 3 (P1b of FRU-598): it says what changed, then leaves alone
 * after `ms`. A pointer over it or the focus in it holds the time; with « reduce motion » it leaves
 * with no movement. `role="status"`: a screen reader says it.
 */
export function changeNotice(document: Document, text: string, ms = 4_000): HTMLElement {
  const notice = make(document, 'div', 'change-notice');
  notice.setAttribute('role', 'status');
  notice.append(drawIcon(document, CHECK), make(document, 'span', 'change-notice-words', text));
  const bar = make(document, 'span', 'change-notice-time');
  bar.setAttribute('aria-hidden', 'true');
  bar.style.animationDuration = `${ms}ms`;
  notice.append(bar);
  const view = document.defaultView;
  if (view === null) return notice;
  let left = ms;
  let started = Date.now();
  let timer: number | undefined;
  const leave = (): void => {
    notice.classList.add('is-leaving');
    view.setTimeout(() => notice.remove(), 200);
  };
  const run = (): void => {
    started = Date.now();
    timer = view.setTimeout(leave, left);
    notice.classList.remove('is-held');
  };
  const hold = (): void => {
    if (timer === undefined) return;
    view.clearTimeout(timer);
    timer = undefined;
    left = Math.max(0, left - (Date.now() - started));
    notice.classList.add('is-held');
  };
  notice.addEventListener('pointerenter', hold);
  notice.addEventListener('pointerleave', run);
  notice.addEventListener('focusin', hold);
  notice.addEventListener('focusout', run);
  run();

  return notice;
}
