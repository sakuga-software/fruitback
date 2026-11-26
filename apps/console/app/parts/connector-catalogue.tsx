import { type ReactNode, type Ref, useState } from 'react';
import type { Connector } from '../api';
import { msg, t } from '../i18n';
import { Button, Field, IconButton, Menu, ViewTab, folded } from '../ui';
import { useLocale } from '../use-locale';
import { ConnectorLogo } from '../connector-logos';
import type { LogoKind } from '../connector-logo-kinds.ts';
import { NoteIcon } from '../note-icons';
import { trackerOf } from '../trackers/index.ts';
import { isPluginKind } from '../trackers/plugin.ts';
import { KEY_PROBLEMS, KINDS } from './connector-parts';
import { Pill } from './connector-health';

/**
 * The catalogue « Add a connector » (FRU-690): a search, the groups of the segment, and a tile for
 * each kind, with its logo, one line of what a note becomes there, and its state. What a tile offers
 * and what opens under it (a form, a refusal) come from the screen, which holds the forms.
 */

/** A group of the catalogue: the segment above the tiles (FRU-690). */
type Group = 'trackers' | 'agents' | 'developers';

/** What a tile of the catalogue says before it is connected: what a note becomes there, in one line. */
export type Entry = { kind: LogoKind; name: string; short: string; group: Group; fresh?: true };

/**
 * The catalogue, in the order of the mockup of FRU-690. `name` is the name of the kind where it can
 * be connected, so a tile and a row say the same; `short` is the one line of the tile, and the long
 * sentence of the kind is its tooltip.
 */
const CATALOGUE: readonly Entry[] = [
  { kind: 'linear', name: KINDS.linear.name, short: msg('An issue in a team'), group: 'trackers' },
  { kind: 'jira', name: KINDS.jira.name, short: msg('An issue in a project'), group: 'trackers' },
  { kind: 'github', name: KINDS.github.name, short: msg('An issue in a repository'), group: 'trackers' },
  { kind: 'gitlab', name: KINDS.gitlab.name, short: msg('An issue in a project'), group: 'trackers' },
  { kind: 'asana', name: KINDS.asana.name, short: msg('A task in a project'), group: 'trackers' },
  { kind: 'clickup', name: KINDS.clickup.name, short: msg('A task in a list'), group: 'trackers' },
  { kind: 'trello', name: 'Trello', short: msg('A card on a board'), group: 'trackers' },
  { kind: 'notion', name: 'Notion', short: msg('A row in a database'), group: 'trackers' },
  { kind: 'slack', name: KINDS.slack.name, short: msg('A message in a channel'), group: 'trackers' },
  { kind: 'webhook', name: msg('Webhook'), short: msg('Tells any address when a note arrives'), group: 'developers' },
  { kind: 'rest', name: KINDS.rest.name, short: msg('A POST to your endpoint'), group: 'developers' },
  {
    kind: 'claude-routine',
    name: KINDS['claude-routine'].name,
    short: msg('A routine of your team starts'),
    group: 'agents',
    fresh: true,
  },
];

/** The long sentence of a kind that this console connects, for the tooltip of its tile. */
const DETAILS: Readonly<Partial<Record<LogoKind, string>>> = {
  linear: msg('An issue per note, in the team you choose.'),
  // FRU-331: the API of an issue of GitHub takes no file, so the files of a note do not go there.
  github: msg('An issue per note, in one repository. The files of a note do not go: GitHub takes none by its API.'),
  rest: msg('POST each note to your own endpoint, with an address of one hour for each of its files.'),
  'claude-routine': msg(
    'Starts a routine of your team when the trigger of a site calls it. The routine reads the notes through the MCP server.',
  ),
  trello: msg('A card in the list you choose.'),
  notion: msg('A row in a database.'),
  webhook: msg('Tells Slack or any address when a note arrives.'),
};

/** The segment of the catalogue: every tile, or one group. */
const GROUPS: readonly { id: Group | 'all'; label: string }[] = [
  { id: 'all', label: msg('All kinds') },
  { id: 'trackers', label: msg('Trackers') },
  { id: 'agents', label: msg('Agents') },
  { id: 'developers', label: msg('Developers') },
];

/**
 * Under 560 px (FRU-727, the phone of the mockup): the search takes a line of its own, 44 px high and
 * in 16 px, and the groups the next one, which scrolls sideways rather than going on two lines.
 */
const NARROW_SEARCH =
  '@max-[560px]:max-w-none @max-[560px]:basis-full @max-[560px]:[&_input]:h-[44px] @max-[560px]:[&_input]:text-[16px]';
const NARROW_GROUPS =
  '@max-[560px]:ml-0 @max-[560px]:w-full @max-[560px]:overflow-x-auto @max-[560px]:[scrollbar-width:none] @max-[560px]:[&_button]:h-[44px]';

/**
 * A press of a finger reaches a control of 44 px (FRU-727): a button of a tile (24 px) takes presses 10 px
 * above and under its box, inside the 64 px of the tile.
 */
const TOUCH =
  'pointer-coarse:[&_button]:relative pointer-coarse:[&_button]:after:absolute pointer-coarse:[&_button]:after:-inset-y-[10px] pointer-coarse:[&_button]:after:inset-x-0';

/** The id of the title « Add a connector », which « New connector » scrolls to. */
export const ADD_TITLE = 'add-title';

/** The long sentence of a kind: its own, or the one of its plugin (FRU-621). */
function detailOf(kind: LogoKind): string {
  const own = DETAILS[kind];
  if (own !== undefined) return t(own);
  const tracker = isPluginKind(kind) ? trackerOf(kind) : undefined;

  return tracker === undefined ? '' : t(tracker.detail);
}

/** What a tile offers: a way to connect, a source that is not set up here, or one that comes later. */
export type Offer =
  | {
      state: 'connect';
      primary: () => void;
      /** The words of the button while the browser leaves for the service. */
      busy?: string | undefined;
      /** A second way: an API key or a token where the consent is the first one. */
      secondary?: { label: string; act: () => void };
    }
  | { state: 'unset'; why: string }
  | { state: 'soon' };

export function Catalogue({
  connected,
  manages,
  available,
  adding,
  connectedKinds,
  offerOf,
  underOf,
  searchRef,
}: {
  /** The workspace has a connector: no sentence of an empty workspace. */
  connected: boolean;
  manages: boolean;
  /** The worker can keep a key. */
  available: boolean;
  /** The kind whose form is open in its tile. */
  adding: Connector['kind'] | undefined;
  /** The kinds of the connectors of the workspace: their tiles say « Connected ». */
  connectedKinds: readonly string[];
  offerOf: (entry: Entry) => Offer;
  /** What opens in a tile under its line; `[]` for nothing. */
  underOf: (kind: LogoKind) => ReactNode[];
  /** The search, which « New connector » and `?new` give focus to. */
  searchRef: Ref<HTMLInputElement>;
}) {
  useLocale();
  // The search and the segment of the catalogue.
  const [typed, setTyped] = useState('');
  const [group, setGroup] = useState<Group | 'all'>('all');
  const cannot = !manages || !available;
  // The tile whose form is open stays, whatever the search and the group: its form can hold the
  // secret of an address, shown once (raised in review).
  const shownEntries = CATALOGUE.filter(
    (entry) =>
      entry.kind === adding ||
      ((group === 'all' || entry.group === group) &&
        (typed.trim() === '' ||
          [t(entry.name), t(entry.short), detailOf(entry.kind)].some((words) =>
            folded(words).includes(folded(typed.trim())),
          ))),
  );

  return (
    // FRU-727: the head and the tiles follow the width of the section, not the one of the window.
    <section aria-labelledby={ADD_TITLE} className="@container">
      <div className="mb-[10px] flex flex-wrap items-center gap-x-[12px] gap-y-[8px]">
        <h2 id={ADD_TITLE} className="text-body leading-auto font-semibold">
          {t('Add a connector')}
        </h2>
        {/*
         * The search grows up to 220 px, and the head goes to a second line where it has no room. Under
         * 560 px it takes the whole width, 44 px high, in 16 px: iOS zooms on a field in a smaller font.
         */}
        <div className={`max-w-[220px] min-w-[160px] flex-[1_1_160px] ${NARROW_SEARCH}`}>
          <Field
            label={t('Search trackers and tools')}
            labelHidden
            compact
            type="search"
            inputRef={searchRef}
            placeholder={t('Search trackers and tools')}
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
          />
        </div>
        <div
          role="group"
          aria-label={t('Kind of connector')}
          className={`ml-auto flex gap-[2px] ${TOUCH} ${NARROW_GROUPS}`}
        >
          {GROUPS.map((each) => (
            <ViewTab key={each.id} pressed={group === each.id} onChange={() => setGroup(each.id)}>
              {t(each.label)}
            </ViewTab>
          ))}
        </div>
      </div>
      {connected ? null : (
        <p className="mb-[10px] text-hint text-muted">{t('No tracker yet. The notes stay in Fruitback.')}</p>
      )}
      {manages ? null : <p className="mb-[10px] text-hint text-muted">{t('An owner or an admin adds a connector')}</p>}
      {available ? null : (
        <p className="mb-[10px] text-hint text-muted">{t(KEY_PROBLEMS['connectors-unavailable'] ?? '')}</p>
      )}
      {shownEntries.length === 0 ? (
        <p className="text-small text-muted" role="status">
          {t('No connector matches « {search} ».', { search: typed.trim() })}
        </p>
      ) : (
        // FRU-690: tiles of 64 px, one at 390 px. FRU-727: no tile narrower than 260 px, so that its
        // button never squeezes its words: four in a row at 1440 px, two at 834 px. A tile whose form
        // is open, or that says why it did not connect, takes the whole row.
        <ul className="grid grid-flow-row-dense grid-cols-[repeat(auto-fill,minmax(min(100%,260px),1fr))] gap-[10px]">
          {shownEntries.map((entry) => {
            const under = underOf(entry.kind);
            const isConnected = connectedKinds.includes(entry.kind);

            return (
              <Tile
                key={entry.kind}
                entry={entry}
                detail={detailOf(entry.kind)}
                offer={offerOf(entry)}
                connected={isConnected}
                cannot={cannot}
                typing={adding === entry.kind}
                under={under}
              />
            );
          })}
        </ul>
      )}
    </section>
  );
}

/** « Connect », with the name of the source for a screen reader: twelve buttons would say the same word. */
function Connect({ name }: { name: string }) {
  useLocale();

  return (
    <>
      {t('Connect')}
      <span className="sr-only"> {name}</span>
    </>
  );
}

/**
 * A tile of the catalogue (FRU-690): the logo in its box of 36 px, the name, one line of what a note
 * becomes there, cut at its end, and the state at the right: « Connected », « Connect », « Soon »,
 * or « Not set up ». A tile that is open (its form, a refusal) takes the whole row, and what opened
 * is under its line.
 */
function Tile({
  entry,
  detail,
  offer,
  connected,
  cannot,
  typing,
  under,
}: {
  entry: Entry;
  detail: string;
  offer: Offer;
  connected: boolean;
  /**
   * The person cannot add a source here: a member, or a worker that cannot keep a key. The tile then
   * offers no button: a line above the tiles says why, and a disabled button would say nothing more.
   */
  cannot: boolean;
  /** Its form is open. */
  typing: boolean;
  /** What opened under its line, or nothing. */
  under: readonly ReactNode[];
}) {
  useLocale();
  const name = t(entry.name);
  const wide = under.length > 0;
  const why = offer.state === 'unset' ? offer.why : undefined;

  return (
    <li
      className={`flex min-w-0 flex-col rounded-card border border-line bg-surface px-[14px] ${wide ? 'col-span-full pb-[14px]' : ''}`}
      data-source={name}
      data-state={connected ? 'connected' : offer.state}
    >
      {/* At least 62 px and its 2 px of border: every tile has the height of the others. */}
      <div className="flex min-h-[62px] min-w-0 items-center gap-[12px]">
        <ConnectorLogo kind={entry.kind} />
        <span className="flex min-w-0 flex-1 flex-col gap-[4px]" title={detail === '' ? undefined : detail}>
          <span className="flex min-w-0 items-center gap-[6px]">
            <span className="truncate text-body leading-auto font-semibold">{name}</span>
            {entry.fresh === true && !connected ? <Pill tone="alert">{t('New')}</Pill> : null}
          </span>
          {/* One line, cut at its end; the whole sentence is the tooltip. */}
          <span className="truncate text-hint leading-auto text-muted" data-tile-line>
            {why ?? t(entry.short)}
          </span>
        </span>
        <span className={`flex flex-none items-center gap-[4px] ${TOUCH}`}>
          {connected ? <Pill tone="done">{t('Connected')}</Pill> : null}
          {offer.state === 'soon' && !connected ? <Pill tone="neutral">{t('Soon')}</Pill> : null}
          {offer.state === 'unset' && !connected ? <Pill tone="neutral">{t('Not set up')}</Pill> : null}
          {/* A workspace can connect a second one: another team of Linear, another address. */}
          {offer.state === 'connect' && !cannot && !typing && connected ? (
            <IconButton
              size="small"
              label={t('Connect another {source}', { source: name })}
              disabled={offer.busy !== undefined}
              onClick={offer.primary}
            >
              <NoteIcon name="add" />
            </IconButton>
          ) : null}
          {offer.state === 'connect' && !cannot && !typing && !connected ? (
            <>
              <Button tone="outline" size="small" disabled={offer.busy !== undefined} onClick={offer.primary}>
                {offer.busy ?? <Connect name={name} />}
              </Button>
              {offer.secondary === undefined ? null : (
                <Menu
                  trigger="icon"
                  triggerLabel={t('Other ways to connect {source}', { source: name })}
                  triggerClassName="size-control-sm!"
                  items={[{ id: 'secondary', label: offer.secondary.label }]}
                  onAction={() => offer.secondary?.act()}
                >
                  <NoteIcon name="down" />
                </Menu>
              )}
            </>
          ) : null}
        </span>
      </div>
      {wide ? <div className="flex w-full flex-col gap-[10px]">{under}</div> : null}
    </li>
  );
}
