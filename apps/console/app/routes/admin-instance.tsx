import { type ReactNode, useCallback, useEffect, useState } from 'react';
import {
  API,
  type DeletedWorkspace,
  type InstanceFacts,
  type InstanceSignIn,
  type InstanceWorkspace,
  type WorkspaceSuspension,
  deletedWorkspaces,
  instanceFacts,
  instanceWorkspaces,
} from '../api';
import { ago, dayOf } from '../ago';
import { locale, msg, t } from '../i18n';
import { useCopy } from '../install-options';
import { type Listed, listedOf } from '../listed';
import { Button, DataTable, Field, Lead, LinkButton, Problem, Radios, Title } from '../ui';
import { useLocale } from '../use-locale';

/**
 * The instance, as screen 17 of the mockup of 2026-10-13 draws it (FRU-262), read-only: what this
 * server runs, its health, how people sign in, and its workspaces.
 *
 * Each setting comes from the environment of the worker, so the screen has no switch, no form and
 * no button that changes one: it names the variable that sets it. The screen sends no write.
 *
 * « Deleted workspaces » (FRU-284) lists the workspaces that an administrator deleted: their owners
 * have no workspace left to read the trace in. Those rows name no workspace that exists, so the read
 * at each visit leaves no trace with any owner.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** The names of the mail providers the worker knows. */
const MAIL_PROVIDERS: Readonly<Record<string, string>> = { 'scaleway-tem': 'Scaleway TEM' };

const DATABASES: Readonly<Record<string, string>> = { postgresql: 'PostgreSQL' };

const SIGN_UP = [
  { value: 'invited', label: msg('Only people invited to a workspace') },
  { value: 'anyone', label: msg('Anyone') },
] as const;

/** « 3 Oct », as the mockup writes a day: the day first, in the language of the console. */

/** How long the worker answers since it started. */
function uptime(startedAt: string, now: number): string {
  const past = now - Date.parse(startedAt);
  if (Number.isNaN(past) || past < MINUTE) return t('Started just now');
  if (past < HOUR) return t('Up for {count} min', { count: Math.floor(past / MINUTE) });
  if (past < DAY) return t('Up for {count} h', { count: Math.floor(past / HOUR) });
  const days = Math.floor(past / DAY);

  return days === 1 ? t('Up for 1 day') : t('Up for {count} days', { count: days });
}

/** The variables that set something, as one sentence. */
function setBy(variables: readonly string[]): string {
  const list = new Intl.ListFormat(locale(), { type: 'conjunction' }).format(variables);

  return t('Set by {variables} in the environment.', { variables: list });
}

export default function AdminInstance() {
  useLocale();
  const [facts, setFacts] = useState<InstanceFacts | 'loading' | 'failed'>('loading');

  const read = useCallback(async () => {
    setFacts('loading');
    const answer = await instanceFacts();
    setFacts(answer.ok && typeof answer.data === 'object' && answer.data !== null ? answer.data : 'failed');
  }, []);

  useEffect(() => void read(), [read]);

  return (
    <>
      <header>
        <Title>{t('Instance')}</Title>
        <Lead className="mt-[6px] max-w-[64ch]">
          {t('Everything this server runs. Each setting comes from the environment of the server.')}
        </Lead>
      </header>

      {facts === 'loading' ? <p className="text-small text-muted">{t('Loading…')}</p> : null}
      {facts === 'failed' ? (
        <div className="flex flex-col items-start gap-[12px]">
          <Problem>{t('The instance could not be read. Fruitback did not answer.')}</Problem>
          <Button tone="outline" onClick={() => void read()}>
            {t('Try again')}
          </Button>
        </div>
      ) : null}
      {typeof facts === 'object' ? (
        <>
          <Health facts={facts} />
          <SignIn facts={facts} />
        </>
      ) : null}

      <Workspaces />
      <Deleted />
    </>
  );
}

function Health({ facts }: { facts: InstanceFacts }) {
  useLocale();
  const now = Date.now();
  const { mail, attention } = facts;
  const provider = mail.provider === null ? undefined : (MAIL_PROVIDERS[mail.provider] ?? mail.provider);
  const named = attention.connectors.map((connector) => `${connector.label}, ${connector.workspace.name}`);
  const unnamed = attention.count - named.length;

  return (
    <section aria-labelledby="health-title">
      <h2 id="health-title" className="mb-[12px] text-section font-bold">
        {t('Health')}
      </h2>
      <dl className="grid grid-cols-[repeat(auto-fit,minmax(min(200px,100%),1fr))] border-y border-line">
        <Fact term={t('Worker')} value={t('Answering')} tone="done" detail={uptime(facts.startedAt, now)} />
        <Fact
          term={t('Database')}
          value={DATABASES[facts.database.kind] ?? facts.database.kind}
          detail={t('Not reported')}
        />
        <Fact
          term={t('Mail')}
          value={provider ?? t('Not set up')}
          detail={mailDetail(provider, mail.lastSentAt, now)}
        />
        <Fact
          term={t('Connectors')}
          value={needsALook(attention.count)}
          {...(attention.count === 0 ? {} : { tone: 'alert' as const })}
          detail={[...named, ...(unnamed > 0 ? [t('{count} more', { count: unnamed })] : [])].join('; ')}
        />
      </dl>
    </section>
  );
}

const TONES = { done: 'text-done', alert: 'text-accent' } as const;

/** What the mail of the instance did last. */
function mailDetail(provider: string | undefined, lastSentAt: string | null, now: number): string {
  if (provider === undefined) return t('No sign-in link goes out by e-mail.');
  if (lastSentAt === null) return t('No link sent since the worker started.');

  return t('Last link sent {when}', { when: ago(lastSentAt, now) });
}

/** How many connectors need somebody. */
function needsALook(count: number): string {
  if (count === 0) return t('All working');

  return count === 1 ? t('{count} needs a look', { count }) : t('{count} need a look', { count });
}

/** One fact of the health of the instance: what it is, its value, and a line under it. */
function Fact({ term, value, tone, detail }: { term: string; value: string; tone?: 'done' | 'alert'; detail: string }) {
  const color = tone === undefined ? '' : TONES[tone];

  return (
    <div className="py-[16px] pr-[20px] last:pr-0">
      <dt className="text-hint text-muted">{term}</dt>
      <dd className={`mt-[4px] text-body leading-auto font-semibold ${color}`}>{value}</dd>
      {detail === '' ? null : <dd className="text-hint text-muted">{detail}</dd>}
    </div>
  );
}

function SignIn({ facts }: { facts: InstanceFacts }) {
  useLocale();
  const { signIn, mail, publicUrl, signUp } = facts;
  const provider = mail.provider === null ? '' : (MAIL_PROVIDERS[mail.provider] ?? mail.provider);
  const redirect = `${publicUrl.value ?? API}/console/auth/callback/google`;

  return (
    <section aria-labelledby="signin-title">
      <h2 id="signin-title" className="mb-[4px] text-section font-bold">
        {t('Sign-in')}
      </h2>
      <p className="mb-[12px] text-small text-muted">
        {t('How people get into this instance, in the console and in the extension.')}
      </p>
      <ul className="border-t border-line">
        <Way
          name={t('Email link')}
          way={signIn.email}
          on={t('Sent through {provider} from {sender}', { provider, sender: mail.sender ?? '' })}
        />
        <Way name="GitHub" way={signIn.github} on={t('An OAuth app is set up.')} />
        <Way name="Google" way={signIn.google} on={t('An OAuth app is set up.')}>
          {signIn.google.on ? null : <Redirect address={redirect} />}
        </Way>
      </ul>

      <div className="mt-[24px]">
        <Radios
          label={t('Who can make an account')}
          value={signUp.policy}
          options={SIGN_UP.map((option) => ({ value: option.value, label: t(option.label) }))}
          disabled
          hint={setBy([signUp.variable])}
        />
      </div>

      <div className="mt-[24px] max-w-[520px]">
        <Field
          label={t('Public address')}
          value={publicUrl.value ?? ''}
          {...(publicUrl.value === null ? { placeholder: t('Not set') } : {})}
          locked
          hint={setBy([publicUrl.variable])}
        />
      </div>
    </section>
  );
}

/** A way to sign in: its name, whether it is set up, and the variables that set it. */
function Way({ name, way, on, children }: { name: string; way: InstanceSignIn; on: string; children?: ReactNode }) {
  useLocale();

  return (
    <li className="flex min-h-[60px] flex-col justify-center border-b border-line py-[8px]">
      <span className="text-body leading-auto font-semibold">{name}</span>
      <span className="text-hint text-muted">{way.on ? on : t('Not set up yet')}</span>
      <span className="text-hint text-muted">{setBy(way.variables)}</span>
      {children}
    </li>
  );
}

/** The address Google sends a person back to, which its OAuth app must know. */
function Redirect({ address }: { address: string }) {
  useLocale();
  const { copied, copy } = useCopy(address);

  return (
    <div className="mt-[10px] mb-[6px] flex flex-wrap items-center gap-x-[16px] gap-y-[10px] text-hint text-muted">
      <span>{t('Redirect address to give Google:')}</span>
      <code className="rounded-button border border-line bg-subtle px-[8px] py-[4px] font-mono text-tiny text-ink [overflow-wrap:anywhere]">
        {address}
      </code>
      <LinkButton onClick={copy}>{copied === 'yes' ? t('Copied') : t('Copy')}</LinkButton>
      {copied === 'refused' ? (
        <span role="status">{t('The browser refused the copy. Select the value above and copy it by hand.')}</span>
      ) : null}
    </div>
  );
}

/**
 * « Suspended since 30 Sep » under the name of a suspended workspace, in the red of the mockup, as
 * the row of a suspended person (FRU-281). On the chosen row the red is the strong accent: the accent
 * is 4.28:1 on the tint of the row.
 */
export function SuspendedSince({ workspace, chosen }: { workspace: WorkspaceSuspension; chosen: boolean }) {
  useLocale();
  if (workspace.suspended !== true) return null;

  return (
    <span className={`block text-hint font-semibold ${chosen ? 'text-accent-strong' : 'text-accent'}`}>
      {workspace.suspendedAt === undefined
        ? t('Suspended')
        : t('Suspended since {day}', { day: dayOf(workspace.suspendedAt) })}
    </span>
  );
}

/**
 * The workspaces of the instance, read on a click only (Mathieu, 2026-10-19). Each read writes a
 * trace in each workspace of the answer that the administrator is not a member of, and its owners
 * read it: a visit to see the health of the server must not tell them that their workspace was read.
 */
function Workspaces() {
  useLocale();
  const [listed, setListed] = useState<{ rows: Listed<InstanceWorkspace> | 'asked-for-none'; total: number }>({
    rows: 'asked-for-none',
    total: 0,
  });

  const read = useCallback(async () => {
    setListed({ rows: 'loading', total: 0 });
    const answer = await instanceWorkspaces();
    const rows = listedOf(answer, (data) => data.workspaces);
    const total = answer.ok && typeof answer.data?.total === 'number' ? answer.data.total : 0;
    setListed({ rows, total });
  }, []);

  const { rows, total } = listed;

  return (
    <section aria-labelledby="workspaces-title">
      <h2 id="workspaces-title" className="mb-[12px] text-section font-bold">
        {t('Workspaces')}
      </h2>
      {rows === 'asked-for-none' ? (
        <div className="flex flex-col items-start gap-[12px]">
          <p className="max-w-[64ch] text-small text-muted">
            {t('The owners of each workspace see that you read its list, with your address and the day.')}
          </p>
          <Button tone="outline" onClick={() => void read()}>
            {t('Show the workspaces')}
          </Button>
        </div>
      ) : null}
      {rows === 'loading' ? <p className="text-small text-muted">{t('Loading…')}</p> : null}
      {rows === 'failed' ? (
        <div className="flex flex-col items-start gap-[12px]">
          <Problem>{t('The workspaces could not be read. Fruitback did not answer.')}</Problem>
          <Button tone="outline" onClick={() => void read()}>
            {t('Try again')}
          </Button>
        </div>
      ) : null}
      {typeof rows !== 'string' && rows.length === 0 ? (
        <p className="text-small text-muted">{t('No workspace on this instance yet.')}</p>
      ) : null}
      {typeof rows !== 'string' && rows.length > 0 ? (
        <>
          <DataTable label={t('Every workspace of the instance')} minWidth={620}>
            <thead>
              <tr>
                <th scope="col">{t('Name')}</th>
                <th scope="col">{t('Owner')}</th>
                <th scope="col" data-align="end">
                  {t('Members')}
                </th>
                <th scope="col" data-align="end">
                  {t('Sites')}
                </th>
                <th scope="col" data-align="end">
                  {t('Created')}
                </th>
              </tr>
            </thead>
            <tbody className="tabular-nums">
              {rows.map((workspace) => (
                <tr key={workspace.id}>
                  <td>
                    <LinkButton to={`/admin/workspaces?open=${encodeURIComponent(workspace.id)}`}>
                      {workspace.name}
                    </LinkButton>
                    <SuspendedSince workspace={workspace} chosen={false} />
                  </td>
                  <td>{workspace.owners.map((owner) => owner.email).join(', ')}</td>
                  <td data-align="end">{workspace.members}</td>
                  <td data-align="end">{workspace.sites}</td>
                  <td data-align="end" className="text-muted">
                    {dayOf(workspace.createdAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </DataTable>
          {total > rows.length ? (
            <p className="mt-[8px] text-hint text-muted">
              {t('The first {count} of {total} workspaces.', { count: rows.length, total })}
            </p>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

/** « 2 sites · 3 people · 5 kept notes »: what went with a deleted workspace. */
function goneOf(deleted: DeletedWorkspace): string {
  const gone = deleted.detail?.gone ?? {};
  const sites = gone.sites ?? 0;
  const people = gone.members ?? 0;
  const notes = gone.keptNotes ?? 0;

  return [
    sites === 1 ? t('1 site') : t('{count} sites', { count: sites }),
    people === 1 ? t('1 person') : t('{count} people', { count: people }),
    notes === 1 ? t('1 kept note') : t('{count} kept notes', { count: notes }),
  ].join(' · ');
}

/** The workspaces that an administrator deleted (FRU-284), the newest first. */
function Deleted() {
  useLocale();
  const [rows, setRows] = useState<Listed<DeletedWorkspace>>('loading');

  const read = useCallback(async () => {
    setRows('loading');
    setRows(listedOf(await deletedWorkspaces(), (data) => data.actions));
  }, []);

  useEffect(() => void read(), [read]);

  return (
    <section aria-labelledby="deleted-title">
      <h2 id="deleted-title" className="mb-[4px] text-section font-bold">
        {t('Deleted workspaces')}
      </h2>
      <p className="mb-[12px] max-w-[64ch] text-small text-muted">
        {t('Deleted by an instance admin. Their owners cannot read this: the workspace is gone.')}
      </p>
      {rows === 'loading' ? <p className="text-small text-muted">{t('Loading…')}</p> : null}
      {rows === 'failed' ? (
        <div className="flex flex-col items-start gap-[12px]">
          <Problem>{t('The deleted workspaces could not be read. Fruitback did not answer.')}</Problem>
          <Button tone="outline" onClick={() => void read()}>
            {t('Try again')}
          </Button>
        </div>
      ) : null}
      {typeof rows !== 'string' && rows.length === 0 ? (
        <p className="text-small text-muted">{t('No workspace was deleted.')}</p>
      ) : null}
      {typeof rows !== 'string' && rows.length > 0 ? (
        <DataTable label={t('Workspaces deleted by an instance admin')} minWidth={620}>
          <thead>
            <tr>
              <th scope="col">{t('Name')}</th>
              <th scope="col">{t('Deleted by')}</th>
              <th scope="col">{t('What went')}</th>
              <th scope="col" data-align="end">
                {t('Deleted')}
              </th>
            </tr>
          </thead>
          <tbody className="tabular-nums">
            {rows.map((deleted, index) => (
              <tr key={`${deleted.workspace?.id ?? ''}-${deleted.at}-${index}`}>
                <td className="font-semibold [overflow-wrap:anywhere]">
                  {deleted.workspace?.name ?? t('A workspace')}
                </td>
                <td className="[overflow-wrap:anywhere]">{deleted.actor.email}</td>
                <td className="text-muted">{goneOf(deleted)}</td>
                <td data-align="end" className="text-muted">
                  {dayOf(deleted.at)}
                </td>
              </tr>
            ))}
          </tbody>
        </DataTable>
      ) : null}
    </section>
  );
}
