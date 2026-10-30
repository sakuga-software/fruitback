import { useCallback, useEffect, useState } from 'react';
import { type Delivery, call } from '../api';
import { msg, t } from '../i18n';
import { writeProblemOf } from '../problems';
import { Button, LinkButton, Problem, SidePanel } from '../ui';
import { useLocale } from '../use-locale';
import {
  BlockTitle,
  Disconnect,
  KINDS,
  type PanelProps,
  SendersList,
  hostOf,
  moment,
  shortHost,
} from './connector-parts';
import { useWorkspace } from './workspace';
import { ReadProblem } from '../read-problem';

/** Where the contract of the request is written, for whoever writes the receiver. */
const REST_GUIDE = 'https://fruitback.com/rest-connector.html';

/** Why a delivery did not arrive, in a few words: the status of the receiver, or what stopped the request. */
function reasonOf(delivery: Delivery): string {
  if (delivery.lastStatus !== undefined) return t('Your receiver answered {status}', { status: delivery.lastStatus });
  if (delivery.lastError !== undefined) return t('No answer: {error}', { error: delivery.lastError });

  return t('Not sent yet');
}

/**
 * The panel of an address that receives (FRU-132): the sites that send their notes there (read only:
 * a site chooses its places on the Sites screen, FRU-399), and the notes that did not arrive.
 */
export function RestPanel({ id, base, connector, sites, manages, onChanged, onRemoved }: PanelProps) {
  useLocale();
  const { workspace } = useWorkspace();
  const [late, setLate] = useState<Delivery[] | undefined>();
  const [problem, setProblem] = useState<string | undefined>();

  const read = useCallback(async () => {
    const listed = await call<{ deliveries: Delivery[] }>('GET', `${base}/connectors/${connector.id}/deliveries`);
    // No list is not an empty list: a worker that did not answer must not read as « all arrived ».
    setLate(listed.ok ? listed.data.deliveries : undefined);
  }, [base, connector.id]);

  useEffect(() => void read(), [read]);

  async function retry(delivery: Delivery) {
    setProblem(undefined);
    const asked = await call('POST', `${base}/connectors/${connector.id}/deliveries/${delivery.id}/retry`);
    if (!asked.ok) setProblem(writeProblemOf(asked, msg('The new attempt was not started. Try again.')));
    await read();
    // The row of the address counts the notes that did not arrive: it is read again too.
    await onChanged();
  }

  async function disconnect() {
    const removed = await call('DELETE', `${base}/connectors/${connector.id}`);
    if (removed.ok) return onRemoved();
    setProblem(writeProblemOf(removed, msg('This source is still connected. Try again.')));
  }

  return (
    <SidePanel
      id={id}
      flush
      title={t(KINDS.rest.name)}
      detail={t('Sends to {host}', { host: hostOf(connector) })}
      {...(manages
        ? {
            foot: (
              <Disconnect
                label={t('Disconnect {source}', { source: t(KINDS.rest.name) })}
                confirmLabel={t('Disconnect {source}', { source: shortHost(connector) })}
                consequence={t('Its sites keep their notes in the workspace, and the notes that waited are not sent.')}
                onConfirm={() => void disconnect()}
              />
            ),
          }
        : {})}
    >
      <SendersList connector={connector} sites={sites} workspaceId={workspace.id} />
      <p className="text-hint text-muted">
        <LinkButton space="inline" href={REST_GUIDE} newTab>
          {t('The request, and how to check its signature')}
        </LinkButton>
      </p>

      <section className="flex flex-col gap-[8px]" data-deliveries>
        <BlockTitle>{t('Notes that did not arrive')}</BlockTitle>
        {late === undefined ? (
          <p className="text-small text-muted">
            {t('This list did not load.')} <ReadProblem alone />
          </p>
        ) : null}
        {late?.length === 0 ? <p className="text-small text-muted">{t('Every note arrived.')}</p> : null}
        <ul className="flex flex-col">
          {(late ?? []).map((delivery) => (
            <li key={delivery.id} className="border-b border-line py-[8px] text-small">
              <span className="block font-semibold">{reasonOf(delivery)}</span>
              {/* FRU-468: the call of a trigger of a site, in the same queue as the notes. */}
              {delivery.event === 'agent.requested' ? (
                <span className="block text-hint text-muted">{t('Call of an agent')}</span>
              ) : null}
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
