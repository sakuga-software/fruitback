import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { type Domain, type SiteChoice, type Workspace, call } from './api';
import { Confirm } from './confirm';
import { locale, msg, t } from './i18n';
import { type Listed, edited, known } from './listed';
import { copyText, problemOf } from './problems';
import { Button, Card, Chip, Choice, Field, Problem } from './ui';
import { useLocale } from './use-locale';
import { siteLabel } from './site-address';
import { ReadProblem } from './read-problem';

/**
 * The domains a workspace proves it owns, to cover the previews of a site (FRU-103).
 *
 * A preview deploy has an address of its own for each branch, so a site cannot name them one by one.
 * A workspace that proves a domain, by a record of its DNS, can say that every address under it is a
 * preview of one of its sites. The worker decides what is proven: this screen shows the record to
 * write, asks the worker to look, and says where the proof stands.
 */

const DOMAIN_PROBLEMS: Readonly<Record<string, string>> = {
  'invalid-domain': msg('This is not a domain. Type the name alone, like preview.acme.dev.'),
  'too-many-domains': msg('A workspace holds 20 domains at most. Remove one first.'),
  forbidden: msg('Only an owner or an admin of the workspace proves a domain.'),
  'domain-not-proven': msg('This domain is not proven, so it covers no preview yet.'),
};
const NOT_ADDED = msg('This domain was not added. Try again.');
const NOT_CHECKED = msg('The DNS was not checked. Try again.');
const SITE_NOT_CHANGED = msg('The site of this domain did not change. Try again.');
const NOT_REMOVED = msg('The domain was not removed. Try again.');
/** The value of the choice « no site ». */
const NONE = 'none';

function moment(iso: string | undefined): string {
  const date = new Date(iso ?? '');

  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString(locale(), { dateStyle: 'medium', timeStyle: 'short' });
}

export function Domains({ workspace, sites }: { workspace: Workspace; sites: Listed<SiteChoice> }) {
  useLocale();
  const base = `/console/workspaces/${workspace.id}/domains`;
  const [domains, setDomains] = useState<Listed<Domain>>('loading');
  const [name, setName] = useState('');
  const [problem, setProblem] = useState<string | undefined>();

  // A read that failed says so, and is asked again: it never reads as « No domain yet » (FRU-162).
  const read = useCallback(async () => {
    setDomains('loading');
    const asked = await call<{ domains?: Domain[] }>('GET', base);
    // An answer with no list is not a list: a worker that does not know the route must not read as « none ».
    setDomains(asked.ok && Array.isArray(asked.data?.domains) ? asked.data.domains : 'failed');
  }, [base]);

  useEffect(() => void read(), [read]);

  const put = (domain: Domain) =>
    setDomains((current) =>
      edited(current, (items) =>
        items.some((each) => each.id === domain.id)
          ? items.map((each) => (each.id === domain.id ? domain : each))
          : [...items, domain],
      ),
    );

  async function add(event: FormEvent) {
    event.preventDefault();
    setProblem(undefined);
    const added = await call<Domain>('POST', base, { domain: name });
    // The field keeps what was typed: the sentence says the cause.
    if (!added.ok) return setProblem(problemOf(added, DOMAIN_PROBLEMS, NOT_ADDED));
    if (typeof domains === 'string') void read();
    else put(added.data);
    setName('');
  }

  return (
    <section className="mt-10" aria-labelledby="domains-title">
      <h2 id="domains-title" className="text-[17px] font-bold">
        {t('Preview deploys')}
      </h2>
      <p className="mb-4 mt-1 text-sm text-muted">
        {t(
          'Each preview has an address of its own. Prove that a domain is yours, and every address under it counts as a preview of the site you choose.',
        )}
      </p>

      <form onSubmit={add} className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-end">
        <div className="flex-1">
          <Field
            label={t('Domain')}
            inputMode="url"
            autoComplete="off"
            placeholder="preview.acme.dev"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </div>
        <Button type="submit" tone="outline" disabled={name.trim() === ''}>
          {t('Add the domain')}
        </Button>
      </form>
      {problem === undefined ? null : (
        <div className="mb-4">
          <Problem>{t(problem)}</Problem>
        </div>
      )}

      <Card>
        {domains === 'loading' ? <p className="p-5 text-sm text-muted">{t('Loading…')}</p> : null}
        {domains === 'failed' ? (
          <div className="flex flex-wrap items-center gap-3 p-5">
            <p role="alert" className="flex-1 text-sm text-muted">
              <ReadProblem /> {t('Your domains are safe.')}
            </p>
            <Button tone="outline" onClick={() => void read()}>
              {t('Try again')}
            </Button>
          </div>
        ) : null}
        {known(domains)?.length === 0 ? (
          <p className="p-5 text-sm text-muted">{t('No domain yet. A site covers its own address only.')}</p>
        ) : null}
        <ul>
          {(known(domains) ?? []).map((domain) => (
            <li key={domain.id} className="border-b border-line px-5 py-4 last:border-b-0" data-domain={domain.domain}>
              <DomainRow
                base={base}
                domain={domain}
                sites={sites}
                onChanged={put}
                onRemoved={() =>
                  setDomains((current) => edited(current, (items) => items.filter((each) => each.id !== domain.id)))
                }
              />
            </li>
          ))}
        </ul>
      </Card>
    </section>
  );
}

function DomainRow({
  base,
  domain,
  sites,
  onChanged,
  onRemoved,
}: {
  base: string;
  domain: Domain;
  sites: Listed<SiteChoice>;
  onChanged: (domain: Domain) => void;
  onRemoved: () => void;
}) {
  useLocale();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | undefined>();
  const [silent, setSilent] = useState(false);
  const [copied, setCopied] = useState<'no' | 'yes' | 'refused'>('no');
  const proven = domain.state === 'proven';

  async function check() {
    setBusy(true);
    setProblem(undefined);
    setSilent(false);
    const checked = await call<Domain & { unanswered?: boolean }>('POST', `${base}/${domain.id}/check`);
    setBusy(false);
    if (!checked.ok) return setProblem(problemOf(checked, DOMAIN_PROBLEMS, NOT_CHECKED));
    const { unanswered, ...now } = checked.data;
    setSilent(unanswered === true);
    onChanged(now);
  }

  async function cover(value: string) {
    setBusy(true);
    setProblem(undefined);
    const site = value === NONE ? null : value;
    const set = await call<Domain>('POST', `${base}/${domain.id}/previews`, { site });
    setBusy(false);
    if (!set.ok) return setProblem(problemOf(set, DOMAIN_PROBLEMS, SITE_NOT_CHANGED));
    onChanged(set.data);
  }

  async function remove() {
    setProblem(undefined);
    const removed = await call('DELETE', `${base}/${domain.id}`);
    if (!removed.ok) return setProblem(problemOf(removed, DOMAIN_PROBLEMS, NOT_REMOVED));
    onRemoved();
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <span className="min-w-0 grow basis-32 text-[15px] font-semibold [overflow-wrap:anywhere]">
          {domain.domain}
        </span>
        <State domain={domain} />
      </div>

      {domain.state === 'lost' ? (
        <Problem>
          {domain.lostAt === undefined
            ? t('The DNS did not confirm this domain for three days. Its previews are not covered until it does.')
            : t(
                'The record is gone from the DNS since {when}. The previews of this domain are not covered until it is back.',
                { when: moment(domain.lostAt) },
              )}
        </Problem>
      ) : null}

      {proven ? null : (
        <div className="rounded-md bg-chip px-3 py-3 text-sm">
          <p className="mb-2">{t('Add this TXT record to the DNS of the domain, then check.')}</p>
          <dl className="grid gap-x-3 gap-y-1 sm:grid-cols-[auto_minmax(0,1fr)]">
            <dt className="text-xs text-muted">{t('Name')}</dt>
            <dd className="font-mono text-xs [overflow-wrap:anywhere]">{domain.record.name}</dd>
            <dt className="text-xs text-muted">{t('Value')}</dt>
            <dd className="font-mono text-xs [overflow-wrap:anywhere]">{domain.record.value}</dd>
          </dl>
          <div className="-ml-3 mt-1 flex flex-wrap items-center">
            <Button
              tone="quiet"
              onClick={() => void copyText(domain.record.value).then((taken) => setCopied(taken ? 'yes' : 'refused'))}
            >
              {copied === 'yes' ? t('Copied') : t('Copy the value')}
            </Button>
          </div>
          {copied === 'refused' ? (
            <p className="text-xs text-muted">
              {t('The browser refused the copy. Select the value above and copy it by hand.')}
            </p>
          ) : null}
        </div>
      )}

      {proven ? (
        <Choice
          label={t('Site whose previews are {pattern}', { pattern: domain.previews.replace('https://', '') })}
          value={domain.previewsSite ?? NONE}
          disabled={busy || typeof sites === 'string'}
          onChange={(value) => void cover(value)}
          options={[
            { value: NONE, label: t('No site') },
            ...(known(sites) ?? []).map((site) => ({ value: site.id, label: siteLabel(site.origin) })),
          ]}
        />
      ) : null}

      {silent ? (
        <p className="text-sm text-muted">
          {t('The DNS did not answer just now. Nothing changed: check again in a minute.')}
        </p>
      ) : null}
      {problem === undefined ? null : <Problem>{t(problem)}</Problem>}

      <div className="-ml-3 flex flex-wrap items-center gap-1">
        <Button tone="quiet" disabled={busy} onClick={() => void check()}>
          {busy ? t('Checking…') : t('Check the DNS')}
        </Button>
        <Confirm
          label={t('Remove')}
          confirmLabel={t('Remove {site}', { site: domain.domain })}
          consequence={t(
            'The previews under {domain} are not covered any more. The record can stay in the DNS: adding the domain again proves it at once.',
            {
              domain: domain.domain,
            },
          )}
          onConfirm={() => void remove()}
        />
      </div>
    </div>
  );
}

function State({ domain }: { domain: Domain }) {
  useLocale();
  if (domain.state === 'proven') return <Chip tone="done">{t('Proven')}</Chip>;
  if (domain.state === 'lost') return <Chip tone="accent">{t('Proof lost')}</Chip>;

  return <Chip>{t('Not proven yet')}</Chip>;
}
