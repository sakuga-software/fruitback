import { useCallback, useEffect, useState } from 'react';
import {
  type AgentMoment,
  type AgentTrigger,
  type Connector,
  type Site,
  type Workspace,
  agentTrigger,
  setAgentTrigger,
} from '../api';
import { msg, t } from '../i18n';
import { type Listed, known } from '../listed';
import { problemOf } from '../problems';
import { Button, Callout, Choice, LinkButton, Pick, Problem, Snippet, Toggle } from '../ui';
import { useLocale } from '../use-locale';
import { connectorName, shortHost } from './connector-parts';

/**
 * « Start an agent », a section of the page of a site (FRU-468, the board `design/agent-triggers/`):
 * off by default; on, it calls an address of the workspace that receives (a REST connector) when a
 * note of a known person arrives, or when a person of the team moves a note to To do. The call
 * carries ids only. For an owner or an admin: the page draws it for them alone.
 */

/** The guide of a team that starts its agent on a note: `docs/agents.md`. */
const GUIDE = 'https://fruitback.com/agents.html#start-an-agent-on-a-note';

/** What a call carries, as the board shows it: ids, never the text. */
function payloadOf(site: Site, moment: AgentMoment): string {
  return JSON.stringify(
    {
      version: 2,
      event: 'agent.requested',
      reason: moment,
      workspace: '…',
      site: { id: site.id, origin: site.origin },
      identifier: 'FB-12',
      note: { id: '…' },
    },
    null,
    2,
  );
}

const TRIGGER_PROBLEMS: Readonly<Record<string, string>> = {
  'unknown-connector': msg('This address is not in the workspace any more. Choose another one.'),
  forbidden: msg('Only an owner or an admin of the workspace starts an agent from a site.'),
};
const NOT_SAVED = msg('The trigger was not saved. Try again.');

type Read = AgentTrigger | null | 'loading' | 'failed';

export function SiteAgent({
  workspace,
  site,
  connectors: listed,
  onRetry,
}: {
  workspace: Workspace;
  site: Site;
  /** The sources of the workspace, as the page of the site reads them. */
  connectors: Listed<Connector>;
  /** Reads the sources again, after a read that failed. */
  onRetry: () => void;
}) {
  useLocale();
  const [read, setRead] = useState<Read>('loading');
  const [enabled, setEnabled] = useState(false);
  const [connector, setConnector] = useState('');
  const [moment, setMoment] = useState<AgentMoment>('verified-note');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [problem, setProblem] = useState<string | undefined>();
  const connectors = known(listed);
  const receivers = (connectors ?? []).filter((each) => each.kind === 'rest');

  const load = useCallback(async () => {
    setRead('loading');
    const answer = await agentTrigger(workspace.id, site.id);
    if (!answer.ok) return setRead('failed');
    // A worker of before FRU-468 has no such route: no trigger, so off.
    const trigger = answer.data?.trigger ?? null;
    setRead(trigger);
    if (trigger !== null) {
      setEnabled(trigger.enabled);
      setConnector(trigger.connector);
      setMoment(trigger.moment);
    }
  }, [workspace.id, site.id]);
  useEffect(() => void load(), [load]);

  // The first address, when none is chosen yet or the one chosen went.
  const chosen = receivers.some((each) => each.id === connector) ? connector : (receivers[0]?.id ?? '');
  const waitingAt = receivers.find(
    (each) => each.id === (typeof read === 'object' && read !== null ? read.connector : ''),
  );

  async function save() {
    if (busy || chosen === '') return;
    setProblem(undefined);
    setSaved(false);
    setBusy(true);
    const answer = await setAgentTrigger(workspace.id, site.id, { connector: chosen, moment, enabled });
    setBusy(false);
    // What was chosen stays on screen: a refusal clears nothing.
    if (!answer.ok) return setProblem(problemOf(answer, TRIGGER_PROBLEMS, NOT_SAVED));
    setRead(answer.data.trigger);
    setSaved(true);
  }

  return (
    <section
      id="agent"
      aria-labelledby="agent-title"
      aria-busy={read === 'loading' || busy}
      className="flex min-w-0 scroll-mt-[24px] flex-col gap-[14px]"
    >
      <h2 id="agent-title" className="text-section font-bold">
        {t('Start an agent')}
      </h2>
      <p className="text-small text-muted">
        {t(
          'When a note arrives, Fruitback can call an address of your team, which starts your agent: a receiver that dispatches a workflow of GitHub that runs Claude Code, or a cloud agent. The call carries the id of the note, never its text: the agent reads it through the MCP server, with its agent key.',
        )}
      </p>
      {read === 'loading' ? <p className="text-small text-muted">{t('Loading…')}</p> : null}
      {listed === 'failed' ? (
        <div role="alert" className="flex flex-wrap items-center gap-[12px]">
          <p className="text-small">{t('The addresses of the workspace did not load.')}</p>
          <Button tone="outline" onClick={onRetry}>
            {t('Try again')}
          </Button>
        </div>
      ) : null}
      {read === 'failed' ? (
        <div role="alert" className="flex flex-wrap items-center gap-[12px]">
          <p className="text-small">{t('The trigger of this site did not load.')}</p>
          <Button tone="outline" onClick={() => void load()}>
            {t('Try again')}
          </Button>
        </div>
      ) : null}
      {typeof read === 'object' && read !== null && read.waiting > 0 && waitingAt !== undefined ? (
        <Callout>
          <p className="text-small">
            {read.waiting === 1
              ? t('1 call did not arrive at {host}. Fruitback tries again; you can try now from the address.', {
                  host: shortHost(waitingAt),
                })
              : t('{count} calls did not arrive at {host}. Fruitback tries again; you can try now from the address.', {
                  count: read.waiting,
                  host: shortHost(waitingAt),
                })}{' '}
            <LinkButton space="inline" to={`/w/${workspace.id}/connectors`}>
              {t('See the calls')}
            </LinkButton>
          </p>
        </Callout>
      ) : null}
      {read !== 'loading' && read !== 'failed' && connectors !== undefined && receivers.length === 0 ? (
        <Callout>
          <p className="text-small">
            {t('The workspace has no address that receives yet. Connect one, then come back here.')}{' '}
            <LinkButton space="inline" to={`/w/${workspace.id}/connectors`}>
              {t('Connect an address')}
            </LinkButton>
          </p>
        </Callout>
      ) : null}
      {read !== 'loading' && read !== 'failed' && receivers.length > 0 ? (
        <>
          <div className="max-w-[640px] rounded-box border border-line px-[16px] py-[12px]">
            <Toggle
              strong
              label={t('Start an agent when a note arrives')}
              hint={
                enabled
                  ? t('On. A call waits in the queue of the address when it fails, and is tried again.')
                  : t('Off. Nothing is called.')
              }
              value={enabled}
              onChange={(on) => {
                setEnabled(on);
                setSaved(false);
              }}
            />
          </div>
          {enabled ? (
            <>
              <div className="max-w-[420px]">
                <Choice
                  label={t('Call')}
                  hint={t(
                    'An address of the workspace that receives (Connectors). Fruitback signs each call with its secret.',
                  )}
                  value={chosen}
                  onChange={(value) => {
                    setConnector(value);
                    setSaved(false);
                  }}
                  options={receivers.map((each) => ({
                    value: each.id,
                    label: each.name === undefined ? shortHost(each) : `${connectorName(each)} · ${shortHost(each)}`,
                  }))}
                />
              </div>
              <Pick
                label={t('When')}
                value={moment}
                onChange={(value) => {
                  setMoment(value);
                  setSaved(false);
                }}
                options={[
                  {
                    value: 'verified-note',
                    label: t('A note of a known person arrives'),
                    detail: t(
                      'A member, or a reviewer your site identified. A note of a visitor starts nothing: anybody can write one.',
                    ),
                  },
                  {
                    value: 'moved-to-todo',
                    label: t('A person of the team moves a note to To do'),
                    detail: t(
                      'Only a note that Fruitback keeps: a note in a tracker takes its status there. An agent that sets a status starts nothing.',
                    ),
                  },
                ]}
              />
              <Snippet label={t('What the call carries')}>{payloadOf(site, moment)}</Snippet>
            </>
          ) : null}
          <p className="text-hint text-muted">
            {t(
              'Your agent opens a pull request for review, and never pushes to a branch that deploys: the guide says how.',
            )}{' '}
            <LinkButton space="inline" href={GUIDE} newTab>
              {t('Start an agent on a note')}
            </LinkButton>
          </p>
          {problem === undefined ? null : <Problem>{t(problem)}</Problem>}
          <div className="flex flex-wrap items-center gap-[12px]">
            <Button tone="outline" size="page" disabled={busy} onClick={() => void save()}>
              {busy ? t('Saving…') : t('Save')}
            </Button>
            <p role="status" className="text-small font-semibold text-done">
              {saved ? t('Saved.') : ''}
            </p>
          </div>
        </>
      ) : null}
    </section>
  );
}
