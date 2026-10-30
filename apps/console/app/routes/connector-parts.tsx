import { useState } from 'react';
import { type Connector, type Destination, type Repository, type Site, type Stage, placesOf } from '../api';
import { Confirmation } from '../confirm';
import { ConnectorMark, type LaterKind, type MarkedKind } from '../connector-marks';
import { locale, msg, t } from '../i18n';
import type { Listed } from '../listed';
import { Chip, LinkButton, Problem } from '../ui';
import { siteLabel } from '../site-address';
import { useLocale } from '../use-locale';

/**
 * What the Connectors screen and the panels of a source share (FRU-246): how a kind of source is
 * named and drawn, the words of a source, and the gesture that disconnects one.
 */

/** How each kind of source is named. Its mark is the logo of its tracker (FRU-543, `connector-marks.tsx`). */
export const KINDS = {
  linear: { name: 'Linear' },
  // « REST API » is said « API REST » in French: `msg` marks it for the guard of the words.
  rest: { name: msg('REST API') },
  github: { name: msg('GitHub Issues') },
} as const;

/** What a refused key means for the person, and what to do. */
export const KEY_PROBLEMS: Record<string, string> = {
  'key-refused': msg('Linear refused this key. Copy it again from Linear, in Settings, then Security and access.'),
  'connectors-unavailable': msg('This Fruitback cannot keep a key yet. Its operator must set FRUITBACK_SECRETS_KEY.'),
  'key-lacks-access': msg(
    'Linear knows this key, and it may not list your teams. Create a key with read and write access, then try again.',
  ),
  forbidden: msg('Only an owner or an admin of the workspace connects a source.'),
  unreachable: msg('Fruitback did not answer. Try again.'),
  'store-unavailable': msg('Linear did not answer just now. Your key is not kept: try again in a minute.'),
};

/** The names of the five stages, as the widget shows them on a pin. */
export const STAGE_NAMES: Record<Stage, string> = {
  new: msg('New'),
  todo: msg('To do'),
  progress: msg('In progress'),
  done: msg('Done'),
  closed: msg('Closed'),
};

/**
 * The mark of a source: the logo of its tracker, 18 px, in the white box of the mockup, 34 px inside
 * its border (FRU-543: the mockup wrote a letter, « L », « G », « { } »). The same box for a source
 * that is connected and for one to add, so that the names of both lists start on one line.
 */
export function SourceMark({ kind }: { kind: MarkedKind | LaterKind }) {
  return (
    <span
      aria-hidden="true"
      className="box-content flex h-[34px] w-[34px] flex-none items-center justify-center rounded-field border border-line bg-surface text-ink"
    >
      <ConnectorMark kind={kind} size={18} />
    </span>
  );
}

/** The host a receiving connector sends to, as the worker named it: `REST · hooks.acme.dev`. */
export function hostOf(connector: Connector): string {
  return connector.label.replace(/^REST · /, '');
}

/** The host of an address alone, so a button that names it fits the panel (FRU-165). */
export function shortHost(connector: Connector): string {
  const address = hostOf(connector);
  try {
    return new URL(address).host;
  } catch {
    return address;
  }
}

/** The person whose key this is, as the worker named the connector: `Linear · Camille`. */
export function personOf(connector: Connector): string {
  return connector.label.replace(/^Linear · /, '');
}

/** A Linear connected with OAuth is named after its workspace of Linear: `Linear OAuth · Acme`. */
export const OAUTH_LABEL = /^Linear OAuth · /;

/** The worker names a connector of the GitHub App after its account: `GitHub App · acme` (FRU-360). */
const GITHUB_LABEL = /^GitHub App · /;

/** The account of GitHub, an organisation or a person, where the App is installed. */
export function accountOf(connector: Connector): string {
  return connector.label.replace(GITHUB_LABEL, '');
}

/**
 * The name of a source, wherever it is shown (FRU-404): the one its workspace gave it, or its kind.
 * Several sources can be of one kind, so a name is what tells them apart.
 */
export function connectorName(connector: Pick<Connector, 'kind' | 'name'>): string {
  return connector.name ?? t(KINDS[connector.kind].name);
}

/**
 * The label of a place of a named source: its name takes the place of the kind that the worker
 * wrote first, « Linear · Design » → « Clients · Design ». A source with no name keeps the label.
 */
export function placeLabel(
  connector: Pick<Connector, 'name'> | undefined,
  label: string | undefined,
): string | undefined {
  if (connector?.name === undefined || label === undefined) return label;
  const cut = label.indexOf(' · ');

  // A label with no kind first (a word of the worker this build does not expect) is kept whole after the name.
  return cut < 0 ? `${connector.name} · ${label}` : `${connector.name}${label.slice(cut)}`;
}

/** How a source is connected, in one line under its name. */
export function sourceLine(connector: Connector): string {
  if (connector.kind === 'rest') return hostOf(connector);
  if (connector.kind === 'github') return t('Installed on {account}', { account: accountOf(connector) });
  if (OAUTH_LABEL.test(connector.label)) {
    return t('Workspace {name}', { name: connector.label.replace(OAUTH_LABEL, '') });
  }

  return t('Key of {person}', { person: personOf(connector) });
}

/** A moment, in the language of the console. */
export function moment(iso: string): string {
  const date = new Date(iso);

  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleString(locale(), { dateStyle: 'medium', timeStyle: 'short' });
}

export function siteCount(count: number): string {
  return count === 1 ? t('{count} site', { count }) : t('{count} sites', { count });
}

/** What the list of sites of a panel says before its rows: loading, not read, or none (FRU-162). */
export function SitesState({ sites }: { sites: Listed<Site> }) {
  useLocale();
  if (sites === 'loading') return <p className="text-small text-muted">{t('Loading…')}</p>;
  if (sites === 'failed') return <p className="text-small text-muted">{t('Fruitback did not answer. Try again.')}</p>;

  return sites.length === 0 ? <p className="text-small text-muted">{t('This workspace has no site yet.')}</p> : null;
}

/** What the panel of a source is given, whatever its kind. */
export type PanelProps = {
  /** The id of the title of the panel. */
  id: string;
  base: string;
  connector: Connector;
  /** Every source of the workspace: a list of places is written with the kind of each one. */
  connectors: readonly Connector[];
  sites: Listed<Site>;
  manages: boolean;
  onChanged: () => Promise<void>;
  onRemoved: () => void;
};

/** The title of a block of a panel. */
export function BlockTitle({ children }: { children: string }) {
  return <h3 className="text-small leading-auto font-semibold">{children}</h3>;
}

/**
 * « Disconnect Linear », at the foot of a panel: underlined words, as the mockup draws them, and a
 * gesture that asks twice (FRU-165). The second time is `Confirmation`. « Keep it » and Escape put
 * the words back, with focus on them.
 */
export function Disconnect({
  label,
  confirmLabel,
  consequence,
  onConfirm,
  keepLabel,
  space = 'normal',
}: {
  label: string;
  confirmLabel: string;
  consequence: string;
  onConfirm: () => void;
  keepLabel?: string;
  /** The space around the words: 10 px at the foot of a panel, 12 px beside a button of a page. */
  space?: 'normal' | 'loose';
}) {
  const [asking, setAsking] = useState(false);
  // Set once the person stepped back: the words then take focus again when they reappear.
  const [back, setBack] = useState(false);

  if (!asking)
    return (
      <LinkButton space={space} autoFocus={back} onClick={() => setAsking(true)}>
        {label}
      </LinkButton>
    );

  return (
    <Confirmation
      confirmLabel={confirmLabel}
      consequence={consequence}
      onConfirm={onConfirm}
      {...(keepLabel === undefined ? {} : { keepLabel })}
      onKeep={() => {
        setBack(true);
        setAsking(false);
      }}
    />
  );
}

/**
 * The sites that send their notes to a source, and where in it (FRU-399): read only. A site chooses
 * its places on the Sites screen, which the last line leads to.
 *
 * With `statuses`, each site also leads to its statuses page (FRU-478). That list was a block of its
 * own, « Status of the pins », under this one: the same sites twice, one above the other.
 */
export function SendersList({
  connector,
  sites,
  workspaceId,
  repositories,
  statuses,
}: {
  connector: Connector;
  sites: Listed<Site>;
  workspaceId: string;
  /**
   * The repositories of a GitHub, as GitHub lists them now: once the list names a repository, its
   * word wins over the worker's, which can be older (FRU-382). Absent: not read, or not GitHub.
   */
  repositories?: readonly Repository[];
  /** The words that say where the stage of each state is set. Present: each site links to its statuses. */
  statuses?: string;
}) {
  useLocale();
  const isPublic = (each: Destination): boolean => {
    const listed = repositories?.find((one) => one.fullName.toLowerCase() === each.teamId);

    return (listed?.private ?? each.private) === false;
  };
  const senders = (typeof sites === 'string' ? [] : sites).filter((site) =>
    placesOf(site).some((each) => each.connector === connector.id),
  );

  return (
    <section>
      <BlockTitle>{t('Sites sending here')}</BlockTitle>
      <div className="mt-[8px]">
        <SitesState sites={sites} />
        {typeof sites !== 'string' && sites.length > 0 && senders.length === 0 ? (
          <p className="text-small text-muted">{t('No site sends its notes here yet.')}</p>
        ) : null}
        <ul>
          {senders.map((site) => {
            const places = placesOf(site);

            return (
              <li
                key={site.id}
                className="border-b border-line py-[8px] text-small"
                data-site={new URL(site.origin).host}
              >
                <p className="flex items-baseline gap-[12px]">
                  <span className="min-w-0 flex-1 font-semibold [overflow-wrap:anywhere]">
                    {siteLabel(site.origin)}
                  </span>
                  {statuses === undefined ? null : (
                    // The site is written just before: the link says « Statuses », and a screen reader
                    // hears which site, the visible word first (WCAG 2.5.3).
                    <LinkButton
                      space="flush"
                      to={`/w/${workspaceId}/sites/${site.id}/statuses`}
                      label={t('Statuses of {site}', { site: siteLabel(site.origin) })}
                    >
                      {t('Statuses')}
                    </LinkButton>
                  )}
                </p>
                <ul className="flex flex-col">
                  {places.map((each, index) =>
                    each.connector === connector.id ? (
                      <li key={`${each.teamId}/${each.projectId}`}>
                        <span className="flex items-center gap-[8px] text-muted">
                          <span className="min-w-0 flex-1 truncate">{each.label ?? t(KINDS[connector.kind].name)}</span>
                          {index === 0 ? <Chip>{t('Default')}</Chip> : null}
                        </span>
                        {/* FRU-382: the worker's word on the repository, for every role that reads it. */}
                        {isPublic(each) ? (
                          <div className="my-[4px]" data-public>
                            <Problem>
                              {t(
                                '{repository} is public: each note of this site becomes an issue that anybody can read.',
                                {
                                  repository: each.teamId ?? '',
                                },
                              )}
                            </Problem>
                          </div>
                        ) : null}
                      </li>
                    ) : null,
                  )}
                </ul>
              </li>
            );
          })}
        </ul>
      </div>
      {statuses === undefined ? null : <p className="mt-[8px] text-hint text-muted">{statuses}</p>}
      <p className="mt-[8px] text-hint text-muted">
        {t('Each site chooses where its notes go, on the Sites screen.')}{' '}
        <LinkButton space="inline" to={`/w/${workspaceId}/sites`}>
          {t('Open the sites')}
        </LinkButton>
      </p>
    </section>
  );
}
