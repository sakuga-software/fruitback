import { useEffect, useRef, useState } from 'react';
import {
  type Connector,
  type ConnectorSettings,
  type Destination,
  MAX_DESTINATIONS,
  type Site,
  type Team,
  UNREACHABLE,
  call,
  placesOf,
  samePlace,
  setPlaces,
} from '../api';
import { msg, t } from '../i18n';
import { writeProblemOf } from '../problems';
import { known } from '../listed';
import { Chip, Choice, LinkButton, Problem, SidePanel, Toggle } from '../ui';
import { useLocale } from '../use-locale';
import { siteLabel } from '../site-address';
import {
  BlockTitle,
  Disconnect,
  KINDS,
  OAUTH_LABEL,
  type PanelProps,
  SitesState,
  moment,
  personOf,
  sourceLine,
} from './connector-parts';
import { useWorkspace } from './workspace';

/** The value of the list « Add a destination… » before a place is chosen. */
const NONE = 'fruitback';

/**
 * What to do about a source that its tracker refuses (FRU-102), by what the tracker said. `{when}` is
 * the first refusal: the notes written since then are not in the tracker.
 */
const ATTENTION: Record<NonNullable<Connector['attention']>['reason'], string> = {
  'key-refused': msg(
    'Linear refuses this connection since {when}, and the notes of its sites do not reach Linear. Disconnect it, then connect Linear again.',
  ),
  'key-lacks-access': msg(
    'Since {when}, Linear refuses what Fruitback asks with this key, and the notes of its sites do not reach Linear. Disconnect it, then connect Linear with a key that has read and write access.',
  ),
  'connection-ended': msg(
    'Linear ended this connection, and since {when} the notes of its sites do not reach Linear. Disconnect it, then connect Linear again.',
  ),
};

/**
 * What the workspace sets on a Linear (FRU-102): whether the replies come back. The stage and the colour
 * of each state are set per site since FRU-368, on the statuses page of the site: this block links
 * there for each site that sends here. The exceptions the workspace set before stay, and a site that
 * sets no stage of its own still takes them.
 */
function Settings({
  base,
  connector,
  senders,
}: {
  base: string;
  connector: Connector & { settings: ConnectorSettings };
  senders: readonly Site[];
}) {
  useLocale();
  const { workspace } = useWorkspace();
  const [settings, setSettings] = useState<ConnectorSettings>(connector.settings);
  const [problem, setProblem] = useState<string | undefined>();
  // What the worker keeps, and the writes in flight, one after the other: a later change starts from
  // the earlier one, and the answers cannot land out of order.
  const kept = useRef<ConnectorSettings>(connector.settings);
  const writes = useRef<Promise<void>>(Promise.resolve());

  function save(change: (current: ConnectorSettings) => ConnectorSettings) {
    setProblem(undefined);
    setSettings((current) => change(current));
    writes.current = writes.current.then(async () => {
      const next = change(kept.current);
      // `call` answers a failure and does not reject. `UNREACHABLE` all the same if it ever does: a
      // rejected link would stop every later write of this chain, with no word on the screen.
      const set = await call('POST', `${base}/connectors/${connector.id}/settings`, next).catch(() => UNREACHABLE);
      if (set.ok) {
        kept.current = next;
        // The setting that failed before is kept now: its sentence goes.
        setProblem(undefined);

        return;
      }
      // What the screen shows must be what the worker keeps.
      setSettings(kept.current);
      setProblem(writeProblemOf(set, msg('This setting did not change. Try again.')));
    });
  }

  return (
    <>
      <section>
        <BlockTitle>{t('Status of the pins')}</BlockTitle>
        <p className="mt-[2px] mb-[10px] text-hint text-muted">
          {t('The stage and the colour of each state of Linear are set for each site, on its statuses page.')}
        </p>
        {senders.length === 0 ? (
          <p className="text-small text-muted">{t('No site sends its notes here yet.')}</p>
        ) : (
          <ul className="flex flex-col gap-[4px] text-small">
            {senders.map((site) => (
              <li key={site.id}>
                <LinkButton to={`/w/${workspace.id}/sites/${site.id}/statuses`}>
                  {t('Statuses of {site}', { site: siteLabel(site.origin) })}
                </LinkButton>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="flex flex-col gap-[12px]">
        <Toggle
          label={t('Show Linear comments as replies')}
          value={settings.showComments}
          onChange={(value) => save((current) => ({ ...current, showComments: value }))}
        />
        {problem === undefined ? null : <Problem>{t(problem)}</Problem>}
      </section>
    </>
  );
}

/** The panel of a Linear: which sites send their notes there, to which team, and its settings. */
export function LinearPanel({ id, base, connector, connectors, sites, manages, onChanged, onRemoved }: PanelProps) {
  useLocale();
  const [teams, setTeams] = useState<Team[] | undefined>();
  const [problem, setProblem] = useState<string | undefined>();
  const [silent, setSilent] = useState(false);
  // A list is written whole, from the list on the screen. A second change before the first one is
  // kept and read again would be made from the list of before, and would take the first one away:
  // the controls wait.
  const [writing, setWriting] = useState(false);

  useEffect(() => {
    if (!manages) return;
    setSilent(false);
    void call<{ teams: Team[] }>('GET', `${base}/connectors/${connector.id}/teams`).then((answer) => {
      if (answer.ok) return setTeams(answer.data.teams);
      setTeams([]);
      setSilent(true);
      // This read is what told the worker that Linear refuses the source: the list is read again, and
      // the reason takes the place of the sentence below.
      void onChanged();
    });
    // `onChanged` is not a reason to ask Linear again: the read above runs once for a connector.
  }, [base, connector.id, manages]);

  /** Writes the whole list of a site: the worker keeps all of it, or none of it. */
  async function place(site: Site, places: Destination[]) {
    // One write at a time: see `writing`.
    if (writing) return;
    setWriting(true);
    setProblem(undefined);
    const set = await setPlaces(base, site, places, connectors);
    if (!set.ok) setProblem(writeProblemOf(set, msg('The destinations of this site did not change. Try again.')));
    await onChanged();
    setWriting(false);
  }

  /** The place a value of the list of teams names: `team`, or `team/project`. */
  function placeOf(value: string): Destination | undefined {
    const [teamId, projectId] = value.split('/');

    return teamId === undefined || teamId === ''
      ? undefined
      : { connector: connector.id, teamId, ...(projectId === undefined ? {} : { projectId }) };
  }

  /** The words of a place: what the worker wrote for it, or the name of its team while that is all there is. */
  function nameOf(each: Destination): string {
    if (each.label !== undefined) return each.label;
    if (each.connector !== connector.id) return t('Another source');
    const team = teams?.find((one) => one.id === each.teamId);
    const project = team?.projects.find((one) => one.id === each.projectId);

    return [t('Linear'), team?.name, project?.name].filter(Boolean).join(' · ');
  }

  async function disconnect() {
    const removed = await call('DELETE', `${base}/connectors/${connector.id}`);
    if (removed.ok) return onRemoved();
    setProblem(writeProblemOf(removed, msg('This source is still connected. Try again.')));
  }

  const listed = known(sites) ?? [];
  const sendsHere = (site: Site) => placesOf(site).some((each) => each.connector === connector.id);
  const senders = listed.filter(sendsHere);
  // Somebody who manages the sources also sees the sites that do not send here, to add this place.
  const others = manages ? listed.filter((site) => !sendsHere(site)) : [];

  /** A site: its places in their order, and what somebody who manages the sources does with them. */
  function row(site: Site) {
    const places = placesOf(site);
    const host = new URL(site.origin).host;
    // A place that is already in the list is not offered again: the worker refuses it twice.
    const free = (value: string): boolean => {
      const wanted = placeOf(value);

      return wanted !== undefined && !places.some((each) => samePlace(each, wanted));
    };
    const offered = (teams ?? [])
      .map((team) => ({
        heading: team.name,
        options: [
          { value: team.id, label: t('{team}, no project', { team: team.name }) },
          ...team.projects.map((project) => ({
            value: `${team.id}/${project.id}`,
            label: `${team.name} · ${project.name}`,
          })),
        ].filter((option) => free(option.value)),
      }))
      .filter((group) => group.options.length > 0);

    return (
      <li key={site.id} className="border-b border-line py-[8px] text-small" data-site={host}>
        <p className="font-semibold [overflow-wrap:anywhere]">{siteLabel(site.origin)}</p>
        {places.length === 0 ? (
          <p className="text-hint text-muted">{t('Its notes stay in Fruitback, in this workspace.')}</p>
        ) : null}
        <ol className="flex flex-col">
          {places.map((each, index) => {
            const own = each.connector === connector.id;
            const rest = places.filter((_, position) => position !== index);

            return (
              <li key={`${each.connector}/${each.teamId}/${each.projectId}`}>
                <span className="flex items-center gap-[8px] text-muted">
                  <span className="min-w-0 flex-1 truncate">{nameOf(each)}</span>
                  {index === 0 ? <Chip>{t('Default')}</Chip> : null}
                </span>
                {manages && own ? (
                  <span className="flex flex-wrap gap-x-[16px]">
                    {index === 0 ? null : (
                      <LinkButton disabled={writing} onClick={() => void place(site, [each, ...rest])}>
                        {t('Make it the default')}
                      </LinkButton>
                    )}
                    <LinkButton disabled={writing} onClick={() => void place(site, rest)}>
                      {t('Remove')}
                    </LinkButton>
                  </span>
                ) : null}
              </li>
            );
          })}
        </ol>
        {manages && places.length < MAX_DESTINATIONS && offered.length > 0 ? (
          <div className="mt-[6px]">
            <Choice
              compact
              label={t('Add a destination for {site}', { site: host })}
              labelHidden
              value={NONE}
              disabled={teams === undefined || writing}
              onChange={(value) => {
                const added = placeOf(value);
                if (value !== NONE && added !== undefined) void place(site, [...places, added]);
              }}
              options={[{ value: NONE, label: t('Add a destination…') }, ...offered]}
            />
          </div>
        ) : null}
        {manages && places.length >= MAX_DESTINATIONS ? (
          <p className="mt-[4px] text-hint text-muted">
            {t('A site sends to {count} places at most.', { count: MAX_DESTINATIONS })}
          </p>
        ) : null}
      </li>
    );
  }

  return (
    <SidePanel
      id={id}
      title={t(KINDS.linear.name)}
      detail={
        OAUTH_LABEL.test(connector.label)
          ? t('Connected to the workspace {name}', { name: connector.label.replace(OAUTH_LABEL, '') })
          : t('Connected with the key of {person}', { person: personOf(connector) })
      }
      {...(manages
        ? {
            foot: (
              <Disconnect
                label={t('Disconnect {source}', { source: t(KINDS.linear.name) })}
                confirmLabel={t('Disconnect {source}', { source: sourceLine(connector) })}
                consequence={t(
                  'Its sites keep their notes in the workspace again. The issues already in Linear stay there.',
                )}
                onConfirm={() => void disconnect()}
              />
            ),
          }
        : {})}
    >
      {connector.attention === undefined ? null : (
        <Problem>{t(ATTENTION[connector.attention.reason], { when: moment(connector.attention.since) })}</Problem>
      )}
      <section>
        <BlockTitle>{t('Sites sending here')}</BlockTitle>
        <div className="mt-[8px]">
          <SitesState sites={sites} />
          {typeof sites !== 'string' && sites.length > 0 && senders.length === 0 ? (
            <p className="text-small text-muted">{t('No site sends its notes here yet.')}</p>
          ) : null}
          <ul>{senders.map(row)}</ul>
        </div>
        {others.length === 0 ? null : (
          <div className="mt-[16px]">
            <BlockTitle>{t('Other sites')}</BlockTitle>
            <ul>{others.map(row)}</ul>
          </div>
        )}
        {listed.length === 0 ? null : (
          <p className="mt-[8px] text-hint text-muted">
            {t(
              'A note goes to the default place. With two places or more, a member chooses one in the widget when they write.',
            )}
          </p>
        )}
        {/* A source with a reason says it above: this sentence is for a Linear that only did not answer. */}
        {silent && connector.attention === undefined ? (
          <div className="mt-[12px]">
            <Problem>
              {t('Linear did not answer for this connection. Disconnect it, then connect Linear again.')}
            </Problem>
          </div>
        ) : null}
        {problem === undefined ? null : (
          <div className="mt-[12px]">
            <Problem>{t(problem)}</Problem>
          </div>
        )}
      </section>
      {manages && connector.settings !== undefined ? (
        <Settings
          key={connector.id}
          base={base}
          connector={{ ...connector, settings: connector.settings }}
          senders={senders}
        />
      ) : null}
    </SidePanel>
  );
}
