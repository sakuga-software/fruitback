import { useCallback, useEffect, useState } from 'react';
import { type AgentSession, type Delivery, call } from '../api';
import { msg, t } from '../i18n';
import { writeProblemOf } from '../problems';
import { Button, LinkButton, Problem, SidePanel } from '../ui';
import { useLocale } from '../use-locale';
import { moment } from '../ago';
import { BlockTitle, Disconnect, KINDS, type PanelProps, routineOf } from './connector-parts';
import { ReadProblem } from '../read-problem';

/** Where a team sets the routine up: the recipe of `docs/agents.md`. */
const ROUTINE_GUIDE = 'https://fruitback.com/agents.html#start-a-claude-code-routine';

/** Why a call did not start the routine: what `/fire` answered, or what stopped the request. */
function reasonOf(delivery: Delivery): string {
  if (delivery.lastStatus !== undefined) return t('The routine answered {status}', { status: delivery.lastStatus });
  if (delivery.lastError !== undefined) return t('No answer: {error}', { error: delivery.lastError });

  return t('Not sent yet');
}

/**
 * The panel of a Claude Code routine (FRU-594): the sessions its calls started, each with its link,
 * and the calls that did not start it. A trigger of a site calls it (the page of the site, « Start an
 * agent »); no site sends its notes there.
 */
export function RoutinePanel({ id, base, connector, manages, onChanged, onRemoved }: PanelProps) {
  useLocale();
  const [read, setRead] = useState<{ deliveries: Delivery[]; sessions: AgentSession[] } | undefined | 'failed'>();
  const [problem, setProblem] = useState<string | undefined>();

  const load = useCallback(async () => {
    const listed = await call<{ deliveries: Delivery[]; sessions?: AgentSession[] }>(
      'GET',
      `${base}/connectors/${connector.id}/deliveries`,
    );
    // No list is not an empty list: a worker that did not answer must not read as « nothing started ».
    setRead(listed.ok ? { deliveries: listed.data.deliveries, sessions: listed.data.sessions ?? [] } : 'failed');
  }, [base, connector.id]);

  useEffect(() => void load(), [load]);

  async function retry(delivery: Delivery) {
    setProblem(undefined);
    const asked = await call('POST', `${base}/connectors/${connector.id}/deliveries/${delivery.id}/retry`);
    if (!asked.ok) setProblem(writeProblemOf(asked, msg('The new attempt was not started. Try again.')));
    await load();
    await onChanged();
  }

  async function disconnect() {
    const removed = await call('DELETE', `${base}/connectors/${connector.id}`);
    if (removed.ok) return onRemoved();
    setProblem(writeProblemOf(removed, msg('This connector is still connected. Try again.')));
  }

  const listed = typeof read === 'object' ? read : undefined;

  return (
    <SidePanel
      id={id}
      flush
      title={t(KINDS['claude-routine'].name)}
      detail={t('Trigger {id}', { id: routineOf(connector) })}
      {...(manages
        ? {
            foot: (
              <Disconnect
                label={t('Disconnect {source}', { source: t(KINDS['claude-routine'].name) })}
                confirmLabel={t('Disconnect {source}', { source: routineOf(connector) })}
                consequence={t('The triggers that call it stop, and the calls that waited are not sent.')}
                onConfirm={() => void disconnect()}
              />
            ),
          }
        : {})}
    >
      {connector.attention?.reason === 'key-refused' ? (
        <Problem>
          {t(
            'The routine refused its token. Generate a new token at claude.ai/code/routines, then connect the routine again.',
          )}
        </Problem>
      ) : null}
      <p className="text-hint text-muted">
        {t(
          'The trigger of a site calls it when a note arrives. The call carries ids only: the routine reads the notes through the MCP server.',
        )}{' '}
        <LinkButton space="inline" href={ROUTINE_GUIDE} newTab>
          {t('Set up the routine')}
        </LinkButton>
      </p>

      {read === 'failed' ? (
        <p className="text-small text-muted">
          {t('This list did not load.')} <ReadProblem alone />
        </p>
      ) : null}

      <section className="flex flex-col gap-[8px]" data-sessions>
        <BlockTitle>{t('Sessions')}</BlockTitle>
        {listed?.sessions.length === 0 ? (
          <p className="text-small text-muted">{t('No call started the routine yet.')}</p>
        ) : null}
        <ul className="flex flex-col">
          {(listed?.sessions ?? []).map((session) => (
            <li key={session.id} className="border-b border-line py-[8px] text-small" data-session>
              <span className="block font-semibold">{t('Session started')}</span>
              <span className="block text-hint text-muted">
                {session.identifiers.join(', ')} · {moment(session.startedAt)}
              </span>
              <LinkButton space="inline" href={session.url} newTab>
                {t('Open the session')}
              </LinkButton>
            </li>
          ))}
        </ul>
      </section>

      <section className="flex flex-col gap-[8px]" data-deliveries>
        <BlockTitle>{t('Calls that did not start it')}</BlockTitle>
        {listed?.deliveries.length === 0 ? <p className="text-small text-muted">{t('Every call arrived.')}</p> : null}
        <ul className="flex flex-col">
          {(listed?.deliveries ?? []).map((delivery) => (
            <li key={delivery.id} className="border-b border-line py-[8px] text-small">
              <span className="block font-semibold">{reasonOf(delivery)}</span>
              <span className="block text-hint text-muted">
                {t('Written {when}', { when: moment(delivery.createdAt) })} ·{' '}
                {delivery.attempts === 1 ? t('1 attempt') : t('{count} attempts', { count: delivery.attempts })}
              </span>
              <span className="block text-hint text-muted">
                {delivery.nextAt === undefined
                  ? t('Fruitback stopped trying.')
                  : t('Next attempt {when}', { when: moment(delivery.nextAt) })}
              </span>
              {manages ? (
                <Button tone="outline" size="small" className="mt-[8px]" onClick={() => void retry(delivery)}>
                  {t('Try now')}
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
        {problem === undefined ? null : <Problem>{t(problem)}</Problem>}
      </section>
    </SidePanel>
  );
}
