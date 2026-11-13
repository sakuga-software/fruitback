import { useRef, useState } from 'react';
import { type Connector, type ConnectorSettings, UNREACHABLE, call } from '../api';
import { msg, t } from '../i18n';
import { writeProblemOf } from '../problems';
import { Button, Problem, SidePanel, Toggle } from '../ui';
import { useLocale } from '../use-locale';
import { moment } from '../ago';
import { Disconnect, KINDS, OAUTH_LABEL, type PanelProps, SendersList, personOf, sourceLine } from './connector-parts';
import { useWorkspace } from '../routes/workspace';

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
  // Only a connector made with OAuth ends so, and its panel says it with `ATTENTION_OAUTH`.
  'connection-ended': msg('Linear ended this connection, and since {when} the notes of its sites do not reach Linear.'),
};

/**
 * What a connector made with OAuth says of a refusal (FRU-633). A new consent gives it a new pair of
 * tokens, and it keeps its id: its sites keep their places, and it keeps its settings.
 */
const ATTENTION_OAUTH: Partial<Record<NonNullable<Connector['attention']>['reason'], string>> = {
  'key-refused': msg('Linear refuses this connection since {when}, and the notes of its sites do not reach Linear.'),
  'connection-ended': msg('Linear ended this connection, and since {when} the notes of its sites do not reach Linear.'),
};

/** What the way back from a new consent says in the panel of its connector (FRU-633). */
export const RECONNECT_RETURNS: Readonly<Record<string, string>> = {
  reconnected: msg('Linear is connected again. Its sites send their notes to the same places.'),
  'other-organization': msg(
    'This connector did not change: you chose another workspace of Linear at Linear. Reconnect it, and choose its workspace of Linear.',
  ),
};

/**
 * A connector made with OAuth that Linear refuses: what happened, and « Reconnect Linear » for who
 * manages the workspace. The browser goes to Linear, and comes back to this panel.
 */
function Reconnect({
  base,
  connector,
  sentence,
  manages,
}: {
  base: string;
  connector: Connector;
  sentence: string;
  manages: boolean;
}) {
  useLocale();
  const [leaving, setLeaving] = useState(false);
  const [problem, setProblem] = useState<string | undefined>();

  async function reconnect() {
    setLeaving(true);
    setProblem(undefined);
    const asked = await call<{ url: string }>('POST', `${base}/connectors/${connector.id}/reconnect`);
    if (asked.ok) return window.location.assign(asked.data.url);
    setLeaving(false);
    setProblem(writeProblemOf(asked, msg('Fruitback could not start the connection to Linear. Try again.')));
  }

  const when = moment(connector.attention?.since ?? '');

  return (
    <div className="flex flex-col gap-[10px]" data-reconnect>
      <Problem>
        {t(sentence, { when })}{' '}
        {manages
          ? t('Reconnect it: its sites and its settings stay as they are.')
          : t('An owner or an admin of the workspace can reconnect it here.')}
      </Problem>
      {manages ? (
        <div>
          <Button tone="primary" size="panel" disabled={leaving} onClick={() => void reconnect()}>
            {t('Reconnect Linear')}
          </Button>
        </div>
      ) : null}
      {problem === undefined ? null : <Problem>{t(problem)}</Problem>}
    </div>
  );
}

/** What the way back from a new consent says (FRU-633): a line that it worked, or a problem. */
function WayBack({ word }: { word: string | undefined }) {
  useLocale();
  const sentence = word === undefined ? undefined : RECONNECT_RETURNS[word];
  if (sentence === undefined) return null;
  if (word !== 'reconnected') return <Problem>{t(sentence)}</Problem>;

  return (
    <p role="status" className="text-small text-muted">
      {t(sentence)}
    </p>
  );
}

/** What the tracker last refused: with « Reconnect Linear » for a connector made with OAuth (FRU-633). */
function Attention({
  base,
  connector,
  reason,
  ended,
  manages,
}: {
  base: string;
  connector: Connector;
  reason: NonNullable<Connector['attention']>['reason'];
  ended: string | undefined;
  manages: boolean;
}) {
  useLocale();
  if (ended !== undefined) return <Reconnect base={base} connector={connector} sentence={ended} manages={manages} />;

  return <Problem>{t(ATTENTION[reason], { when: moment(connector.attention?.since ?? '') })}</Problem>;
}

/**
 * What the workspace sets on a Linear (FRU-102): whether the replies come back. The stage and the colour
 * of each state are set per site since FRU-368, on the statuses page of the site: each site of
 * « Sites sending here » links there (FRU-478). The exceptions the workspace set before stay, and a
 * site that sets no stage of its own still takes them.
 */
function Settings({ base, connector }: { base: string; connector: Connector & { settings: ConnectorSettings } }) {
  useLocale();
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
    <section className="flex flex-col gap-[12px]">
      <Toggle
        label={t('Show Linear comments as replies')}
        value={settings.showComments}
        onChange={(value) => save((current) => ({ ...current, showComments: value }))}
      />
      {problem === undefined ? null : <Problem>{t(problem)}</Problem>}
    </section>
  );
}

/**
 * The panel of a Linear: the sites that send their notes there (read only: a site chooses its places
 * on the Sites screen, FRU-399), and its settings.
 */
export function LinearPanel({ id, base, connector, sites, manages, onRemoved, back }: PanelProps) {
  useLocale();
  const oauth = OAUTH_LABEL.test(connector.label);
  const ended = connector.attention === undefined || !oauth ? undefined : ATTENTION_OAUTH[connector.attention.reason];
  const { workspace } = useWorkspace();
  const [problem, setProblem] = useState<string | undefined>();

  async function disconnect() {
    const removed = await call('DELETE', `${base}/connectors/${connector.id}`);
    if (removed.ok) return onRemoved();
    setProblem(writeProblemOf(removed, msg('This connector is still connected. Try again.')));
  }

  return (
    <SidePanel
      id={id}
      flush
      title={t(KINDS.linear.name)}
      detail={
        oauth
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
      <WayBack word={back} />
      {connector.attention === undefined ? null : (
        <Attention
          base={base}
          connector={connector}
          reason={connector.attention.reason}
          ended={ended}
          manages={manages}
        />
      )}
      {/* One list of the sites, each with its places and, for who sets them, its statuses (FRU-478). */}
      <SendersList
        connector={connector}
        sites={sites}
        workspaceId={workspace.id}
        {...(manages && connector.settings !== undefined
          ? {
              statuses: t(
                'The stage and the colour of each state of Linear are set for each site, on its statuses page.',
              ),
            }
          : {})}
      />
      {problem === undefined ? null : <Problem>{t(problem)}</Problem>}
      {manages && connector.settings !== undefined ? (
        <Settings key={connector.id} base={base} connector={{ ...connector, settings: connector.settings }} />
      ) : null}
    </SidePanel>
  );
}
