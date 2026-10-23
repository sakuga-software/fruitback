import { useCallback, useEffect, useState } from 'react';
import { type Delivery, MAX_DESTINATIONS, type Site, call, hasRoomFor, placesOf, setPlaces } from '../api';
import { msg, t } from '../i18n';
import { writeProblemOf } from '../problems';
import { known } from '../listed';
import { Button, Choice, LinkButton, Problem, SidePanel } from '../ui';
import { useLocale } from '../use-locale';
import { siteLabel } from '../site-address';
import {
  BlockTitle,
  Disconnect,
  KINDS,
  type PanelProps,
  SitesState,
  hostOf,
  moment,
  shortHost,
} from './connector-parts';

const HERE = 'fruitback';
/** The value of the choice « this site sends its notes to the address ». */
const THERE = 'address';

/** Where the contract of the request is written, for whoever writes the receiver. */
const REST_GUIDE = 'https://fruitback.com/rest-connector.html';

/** Why a delivery did not arrive, in a few words: the status of the receiver, or what stopped the request. */
function reasonOf(delivery: Delivery): string {
  if (delivery.lastStatus !== undefined) return t('Your receiver answered {status}', { status: delivery.lastStatus });
  if (delivery.lastError !== undefined) return t('No answer: {error}', { error: delivery.lastError });

  return t('Not sent yet');
}

/**
 * The panel of an address that receives (FRU-132): which sites send their notes there, and the notes
 * that did not arrive. A site has no team to choose here: it sends, or it does not.
 */
export function RestPanel({ id, base, connector, connectors, sites, manages, onChanged, onRemoved }: PanelProps) {
  useLocale();
  const [late, setLate] = useState<Delivery[] | undefined>();
  // A list is written whole, from the list on the screen. A second change before the first one is
  // kept and read again would be made from the list of before, and would take the first one away:
  // the controls wait.
  const [writing, setWriting] = useState(false);
  const [problem, setProblem] = useState<string | undefined>();

  const read = useCallback(async () => {
    const listed = await call<{ deliveries: Delivery[] }>('GET', `${base}/connectors/${connector.id}/deliveries`);
    // No list is not an empty list: a worker that did not answer must not read as « all arrived ».
    setLate(listed.ok ? listed.data.deliveries : undefined);
  }, [base, connector.id]);

  useEffect(() => void read(), [read]);

  async function place(site: Site, value: string) {
    // One write at a time: see `writing`.
    if (writing) return;
    setWriting(true);
    setProblem(undefined);
    // The other places of the site stay, in their order: this address is added last, or taken out.
    const others = placesOf(site).filter((each) => each.connector !== connector.id);
    const set = await setPlaces(
      base,
      site,
      value === THERE ? [...others, { connector: connector.id }] : others,
      connectors,
    );
    if (!set.ok) setProblem(writeProblemOf(set, msg('The destination of this site did not change. Try again.')));
    await onChanged();
    setWriting(false);
  }

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
      <section className="flex flex-col gap-[8px]">
        <BlockTitle>{t('Sites sending here')}</BlockTitle>
        <SitesState sites={sites} />
        <ul className="flex flex-col gap-[10px]">
          {(known(sites) ?? []).map((site) => {
            const places = placesOf(site);
            const sends = places.some((each) => each.connector === connector.id);
            // The worker refuses a sixth place: the reason is said here, and the choice is not offered.
            const full = !hasRoomFor(site, connector.id);
            const elsewhere = places.some((each) => each.connector !== connector.id);

            return (
              <li key={site.id}>
                <Choice
                  compact
                  label={siteLabel(site.origin)}
                  value={sends ? THERE : HERE}
                  disabled={!manages || full || writing}
                  onChange={(value) => void place(site, value)}
                  options={[
                    { value: HERE, label: elsewhere ? t('Another source') : t('Fruitback only') },
                    { value: THERE, label: t('Fruitback, and this address') },
                  ]}
                />
                {manages && full ? (
                  <p className="mt-[4px] text-hint text-muted">
                    {t('A site sends to {count} places at most.', { count: MAX_DESTINATIONS })}
                  </p>
                ) : null}
              </li>
            );
          })}
        </ul>
        <p className="text-hint text-muted">
          <LinkButton space="inline" href={REST_GUIDE} newTab>
            {t('The request, and how to check its signature')}
          </LinkButton>
        </p>
      </section>

      <section className="flex flex-col gap-[8px]" data-deliveries>
        <BlockTitle>{t('Notes that did not arrive')}</BlockTitle>
        {late === undefined ? (
          <p className="text-small text-muted">{t('Fruitback did not answer. Try again.')}</p>
        ) : null}
        {late?.length === 0 ? <p className="text-small text-muted">{t('Every note arrived.')}</p> : null}
        <ul className="flex flex-col">
          {(late ?? []).map((delivery) => (
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
