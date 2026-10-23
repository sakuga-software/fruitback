import { useRef, useState } from 'react';
import { type Connector, type ConnectorSettings, type Site, UNREACHABLE, call, placesOf } from '../api';
import { msg, t } from '../i18n';
import { writeProblemOf } from '../problems';
import { known } from '../listed';
import { LinkButton, Problem, SidePanel, Toggle } from '../ui';
import { useLocale } from '../use-locale';
import { siteLabel } from '../site-address';
import {
  BlockTitle,
  Disconnect,
  KINDS,
  OAUTH_LABEL,
  type PanelProps,
  SendersList,
  moment,
  personOf,
  sourceLine,
} from './connector-parts';
import { useWorkspace } from './workspace';

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

/**
 * The panel of a Linear: the sites that send their notes there (read only: a site chooses its places
 * on the Sites screen, FRU-399), and its settings.
 */
export function LinearPanel({ id, base, connector, sites, manages, onRemoved }: PanelProps) {
  useLocale();
  const { workspace } = useWorkspace();
  const [problem, setProblem] = useState<string | undefined>();

  async function disconnect() {
    const removed = await call('DELETE', `${base}/connectors/${connector.id}`);
    if (removed.ok) return onRemoved();
    setProblem(writeProblemOf(removed, msg('This source is still connected. Try again.')));
  }

  const senders = (known(sites) ?? []).filter((site) => placesOf(site).some((each) => each.connector === connector.id));

  return (
    <SidePanel
      id={id}
      flush
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
      <SendersList connector={connector} sites={sites} workspaceId={workspace.id} />
      {problem === undefined ? null : <Problem>{t(problem)}</Problem>}
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
