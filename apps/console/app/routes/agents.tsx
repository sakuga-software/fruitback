import { type FormEvent, type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import {
  API,
  type AgentKey,
  type AgentWrite,
  AGENT_WRITES_LISTED,
  DEFAULT_AGENT_KEY_DAYS,
  MAX_AGENT_KEYS,
  MAX_AGENT_KEY_SITES,
  type Site,
  type Stage,
  STAGES,
  agentKeys,
  agentWrites,
  call,
  makeAgentKey,
  revokeAgentKey,
} from '../api';
import { ago, dayOf } from '../ago';
import { claudeLine, daysOf, endOf, keyEnd, statusKey } from '../agent-keys';
import { Confirm } from '../confirm';
import { msg, t } from '../i18n';
import { type Listed, listedOf } from '../listed';
import { copyText, problemOf, writeProblemOf } from '../problems';
import { manages } from '../setup-stage';
import { siteName } from '../site-address';
import { Button, Callout, Checks, Field, LinkButton, Pick, Problem, Snippet, Toggle } from '../ui';
import { useLocale } from '../use-locale';
import { STAGE_NAMES } from './connector-parts';
import { PageHead, useWorkspace } from './workspace';

/**
 * The agent keys of a workspace (FRU-462), the board `design/agents/`: make a key, shown once with
 * the line that connects Claude Code; list the keys with their last use and their end, and a warning
 * 7 days before it; the writes of each key; revoke one. The routes are those of FRU-461 and FRU-464.
 *
 * Reached from the section « Agents » of the page « AI » of the settings (FRU-544), for an owner or an admin: the worker
 * answers `403` to anybody else, so the page asks it nothing for them.
 */
export default function Agents() {
  const { workspace } = useWorkspace();

  // A move to another workspace mounts the screen again: a key shown for one is never left on screen
  // for another.
  return <AgentsScreen key={workspace.id} />;
}

/** The guide of a team that connects an agent: `docs/agents.md` on the site of the documentation. */
const GUIDE = 'https://fruitback.com/agents.html';
const GUIDE_ELSEWHERE = `${GUIDE}#connect-an-agent-that-runs-elsewhere`;

/** A key just made: its view, and the key itself, which the worker gives this once. */
type Made = { key: AgentKey; secret: string };

function AgentsScreen() {
  useLocale();
  const { workspace } = useWorkspace();
  const may = manages(workspace);
  const [keys, setKeys] = useState<Listed<AgentKey>>('loading');
  const [sites, setSites] = useState<Listed<Site>>('loading');
  const [forming, setForming] = useState(false);
  const [made, setMade] = useState<Made | undefined>();
  // The name of the key revoked last: its sentence is translated where it is shown.
  const [revoked, setRevoked] = useState<string | undefined>();
  const newKey = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    setKeys('loading');
    const [listed, read] = await Promise.all([
      agentKeys(workspace.id),
      call<{ sites: Site[] }>('GET', `/console/workspaces/${workspace.id}/sites`),
    ]);
    setKeys(listedOf(listed, (data) => data.keys));
    setSites(listedOf(read, (data) => data.sites));
  }, [workspace.id]);

  useEffect(() => {
    if (may) void load();
  }, [load, may]);

  /** Focus goes back to « New key » once the form or the key shown once is gone. */
  const backToNew = () => requestAnimationFrame(() => newKey.current?.querySelector<HTMLElement>('a, button')?.focus());

  const crumbs = (
    // The crumbs are in the room above the title, as on the page of the statuses (FRU-405).
    <nav
      aria-label={t('Breadcrumb')}
      className="-mt-[31px] mb-[10px] flex flex-wrap items-center gap-[8px] text-small text-muted"
    >
      <LinkButton space="inline" to={`/w/${workspace.id}/settings`}>
        {t('Workspace settings')}
      </LinkButton>
      <span aria-hidden="true">›</span>
      {/* The keys are reached from the page « AI » of the settings (FRU-544). */}
      <LinkButton space="inline" to={`/w/${workspace.id}/settings/ai`}>
        {t('AI')}
      </LinkButton>
      <span aria-hidden="true">›</span>
      <span>{t('Agents')}</span>
    </nav>
  );
  const lead = t(
    'A key lets an AI agent of your team read the notes of some sites through the MCP server of Fruitback, and reply to them when you allow it. Fruitback calls no model: the agent is yours.',
  );

  if (!may)
    return (
      <>
        {crumbs}
        <PageHead title={t('Agents')} lead={lead} />
        <p className="text-body text-muted">
          {t('Only an owner or an admin of the workspace manages its agent keys.')}
        </p>
      </>
    );

  const listed = Array.isArray(keys) ? (keys as readonly AgentKey[]) : undefined;
  const workspaceSites = Array.isArray(sites) ? (sites as readonly Site[]) : undefined;
  const full = listed !== undefined && listed.length >= MAX_AGENT_KEYS;
  const busy = forming || made !== undefined;
  let action = null;
  if (listed !== undefined && workspaceSites !== undefined) {
    action =
      workspaceSites.length === 0 ? (
        <Button tone="outline" size="page" to={`/w/${workspace.id}/sites`}>
          {t('Add a site first')}
        </Button>
      ) : (
        <Button
          disabled={busy || full}
          onClick={() => {
            setRevoked(undefined);
            setForming(true);
          }}
        >
          {t('New key')}
        </Button>
      );
  }

  // FRU-503: with no key, the action is in the card that says what a key is for, and the head has none.
  // Two « New key » one under the other read as two different things.
  const placed =
    action === null ? undefined : (
      <div ref={newKey} className="flex-none">
        {action}
      </div>
    );
  const empty = listed !== undefined && listed.length === 0;

  return (
    <>
      {crumbs}
      <PageHead title={t('Agents')} lead={lead} action={empty && !busy ? undefined : placed} />
      <p className="-mt-[16px] mb-[24px] text-small">
        <LinkButton space="inline" href={GUIDE} newTab>
          {t('Connect an AI agent')}
        </LinkButton>
      </p>
      {keys === 'loading' ? <p className="text-small text-muted">{t('Loading…')}</p> : null}
      {keys === 'failed' || (listed !== undefined && sites === 'failed') ? (
        <div role="alert" className="flex flex-wrap items-center gap-[16px]">
          <p className="text-body">{t('The agent keys did not load.')}</p>
          <Button tone="outline" onClick={() => void load()}>
            {t('Try again')}
          </Button>
        </div>
      ) : null}
      {forming && workspaceSites !== undefined ? (
        <KeyForm
          sites={workspaceSites}
          onCancel={() => {
            setForming(false);
            backToNew();
          }}
          onMade={(fresh) => {
            setForming(false);
            setMade(fresh);
            setKeys((current) => (Array.isArray(current) ? [...current, fresh.key] : current));
          }}
        />
      ) : null}
      {made === undefined ? null : (
        <ShownOnce
          made={made}
          onKept={() => {
            setMade(undefined);
            backToNew();
          }}
        />
      )}
      {listed === undefined || workspaceSites === undefined ? null : (
        <KeyList
          keys={listed}
          busy={busy}
          action={placed}
          onRevoked={(gone) => {
            setKeys((current) => (Array.isArray(current) ? current.filter((each) => each.id !== gone.id) : current));
            setRevoked(gone.name);
            backToNew();
          }}
        />
      )}
      <p role="status" className="mt-[10px] text-small text-muted">
        {revoked === undefined ? '' : t('« {name} » is revoked.', { name: revoked })}
      </p>
    </>
  );
}

/** What the worker refuses when a key is made, by its code. */
const MAKE_PROBLEMS: Readonly<Record<string, string>> = {
  'invalid-name': msg('Give the key a name of one line, up to 80 characters.'),
  'invalid-sites': msg('Choose from 1 to 20 sites.'),
  'unknown-site': msg('A site you chose is not in the workspace any more. Reload the page.'),
  'invalid-days': msg('Choose from 1 to 365 days.'),
  'too-many-keys': msg('A workspace holds 20 keys at most. Revoke one to make another.'),
  forbidden: msg('Only an owner or an admin of the workspace manages its agent keys.'),
};
const KEY_NOT_MADE = msg('The key was not made. Try again.');

function KeyForm({
  sites,
  onCancel,
  onMade,
}: {
  sites: readonly Site[];
  onCancel: () => void;
  onMade: (made: Made) => void;
}) {
  useLocale();
  const { workspace } = useWorkspace();
  const [name, setName] = useState('');
  const [chosen, setChosen] = useState<readonly string[]>([]);
  const [rights, setRights] = useState<'read' | 'write'>('read');
  const [days, setDays] = useState(String(DEFAULT_AGENT_KEY_DAYS));
  const [verifiedOnly, setVerifiedOnly] = useState(true);
  const [errors, setErrors] = useState<{ name?: string; sites?: string; days?: string }>({});
  const [problem, setProblem] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const daysRef = useRef<HTMLInputElement>(null);
  const sitesRef = useRef<HTMLDivElement>(null);

  useEffect(() => nameRef.current?.focus(), []);

  const lives = daysOf(days);
  const full = chosen.length >= MAX_AGENT_KEY_SITES;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    const found = {
      ...(name.trim() === '' ? { name: t('Give the key a name.') } : {}),
      ...(chosen.length === 0 ? { sites: t('Choose at least one site.') } : {}),
      ...(lives === undefined ? { days: t('Choose from 1 to 365 days.') } : {}),
    };
    setErrors(found);
    setProblem(undefined);
    // Focus goes to the first field that needs something. Nothing typed is cleared.
    if (found.name !== undefined) return nameRef.current?.focus();
    if (found.sites !== undefined) return sitesRef.current?.querySelector('input')?.focus();
    if (lives === undefined) return daysRef.current?.focus();
    setBusy(true);
    const answer = await makeAgentKey(workspace.id, {
      name: name.trim(),
      sites: [...chosen],
      rights,
      days: lives,
      verifiedOnly,
    });
    setBusy(false);
    if (!answer.ok) return setProblem(problemOf(answer, MAKE_PROBLEMS, writeProblemOf(answer, KEY_NOT_MADE)));
    const { secret, ...key } = answer.data;
    onMade({ key, secret });
  }

  return (
    <section
      aria-labelledby="new-key-title"
      className="mb-[24px] max-w-[760px] rounded-frame border border-line p-[clamp(16px,3vw,28px)]"
    >
      <h2 id="new-key-title" className="mb-[16px] text-section font-bold">
        {t('New agent key')}
      </h2>
      <form noValidate onSubmit={(event) => void submit(event)} className="flex flex-col gap-[20px]">
        <div className="max-w-[420px]">
          <Field
            label={t('Name')}
            value={name}
            maxLength={80}
            autoComplete="off"
            inputRef={nameRef}
            onChange={(event) => setName(event.target.value)}
            {...(errors.name === undefined
              ? { hint: t('Its replies are signed with it, beside « Agent ».') }
              : { error: errors.name })}
          />
        </div>
        <Checks
          label={t('Sites')}
          value={chosen}
          onChange={setChosen}
          groupRef={sitesRef}
          options={sites.map((site) => ({
            value: site.id,
            label: siteName(site.origin),
            detail: site.visibility === 'everyone' ? t('Everyone reads its notes') : t('Members read its notes'),
            // Past 20 sites, a box not ticked takes no press: the worker refuses a 21st.
            disabled: full && !chosen.includes(site.id),
          }))}
          hint={t('The key reads nothing of another site. 20 at most.')}
          {...(errors.sites === undefined ? {} : { error: errors.sites })}
        />
        <Pick
          label={t('What the agent can do')}
          value={rights}
          onChange={setRights}
          options={[
            {
              value: 'read',
              label: t('Read the notes'),
              detail: t('Their text, page, element, component, file and line, picture, replies and status.'),
            },
            {
              value: 'write',
              label: t('Read, reply and set a status'),
              detail: t('A reply says it is from an agent. A status is set only on a note that Fruitback keeps.'),
            },
          ]}
        />
        <div className="max-w-[240px]">
          <Field
            label={t('Lives for, in days')}
            value={days}
            inputMode="numeric"
            inputRef={daysRef}
            onChange={(event) => setDays(event.target.value)}
            {...(errors.days === undefined
              ? {
                  hint:
                    lives === undefined
                      ? t('From 1 to 365 days: no key lives with no end.')
                      : t('Ends on {day}. From 1 to 365 days: no key lives with no end.', {
                          day: dayOf(endOf(lives, Date.now())),
                        }),
                }
              : { error: errors.days })}
          />
        </div>
        <div className="max-w-[640px] rounded-box border border-line px-[16px] py-[12px]">
          <Toggle
            strong
            label={t('Only the notes of known people')}
            hint={t(
              'On a site that everyone reads, the agent does not see a note of a visitor: anybody can write one, and an agent can obey its text. Turn it off only knowing that.',
            )}
            value={verifiedOnly}
            onChange={setVerifiedOnly}
          />
        </div>
        {problem === undefined ? null : <Problem>{t(problem)}</Problem>}
        <div className="flex flex-wrap items-center gap-x-[16px] gap-y-[8px]">
          <Button type="submit" disabled={busy}>
            {busy ? t('Making…') : t('Make the key')}
          </Button>
          <LinkButton onClick={onCancel}>{t('Cancel')}</LinkButton>
        </div>
      </form>
    </section>
  );
}

/** The key, the one time the worker gives it, and the line that connects Claude Code with it. */
function ShownOnce({ made, onKept }: { made: Made; onKept: () => void }) {
  useLocale();
  const line = claudeLine(API, made.secret);
  const [copied, setCopied] = useState<'none' | 'key' | 'line' | 'refused'>('none');
  const title = useRef<HTMLHeadingElement>(null);

  useEffect(() => title.current?.focus(), []);

  const copy = (what: 'key' | 'line') =>
    void copyText(what === 'key' ? made.secret : line).then((taken) => setCopied(taken ? what : 'refused'));

  return (
    <section
      aria-labelledby="key-made-title"
      className="mb-[24px] flex max-w-[760px] flex-col gap-[10px] rounded-frame border border-line p-[clamp(16px,3vw,28px)]"
    >
      <h2 id="key-made-title" ref={title} tabIndex={-1} className="text-section font-bold">
        {t('« {name} » is made', { name: made.key.name })}
      </h2>
      <p className="text-body font-semibold">
        {t('Copy the key now: Fruitback shows it only once, and keeps only its digest.')}
      </p>
      <div className="flex flex-wrap items-center gap-[10px]">
        <code
          data-secret
          className="min-w-0 flex-[1_1_320px] rounded-button bg-chip px-[14px] py-[12px] font-mono text-tiny break-all"
        >
          {made.secret}
        </code>
        <Button tone="outline" size="page" onClick={() => copy('key')}>
          {copied === 'key' ? t('Copied') : t('Copy the key')}
        </Button>
      </div>
      <h3 className="mt-[12px] text-body font-bold">{t('Connect Claude Code')}</h3>
      <p className="text-hint text-muted">
        {t('Run this line where Claude Code runs. It holds the key: paste it nowhere else.')}
      </p>
      <Snippet label={t('The line that connects Claude Code')}>{line}</Snippet>
      <div className="flex flex-wrap items-center gap-x-[16px] gap-y-[8px]">
        <Button tone="outline" size="page" onClick={() => copy('line')}>
          {copied === 'line' ? t('Copied') : t('Copy the line')}
        </Button>
        <LinkButton href={GUIDE_ELSEWHERE} newTab>
          {t('Another agent, in CI or in the cloud')}
        </LinkButton>
      </div>
      {/* A clipboard can refuse. The key is on the screen, to select by hand, and this says so. */}
      {copied === 'refused' ? (
        <p role="alert" className="text-hint text-muted">
          {t('The browser refused the copy. Select the key above and copy it by hand.')}
        </p>
      ) : null}
      <div className="mt-[8px] flex justify-end">
        <Button onClick={onKept}>{t('I kept it')}</Button>
      </div>
    </section>
  );
}

function KeyList({
  keys,
  busy,
  action,
  onRevoked,
}: {
  keys: readonly AgentKey[];
  busy: boolean;
  /** « New key », or « Add a site first »: the one action of the page, in the card when there is no key. */
  action: ReactNode;
  onRevoked: (key: AgentKey) => void;
}) {
  useLocale();
  const now = Date.now();

  if (keys.length === 0)
    return busy ? null : (
      <div className="max-w-[760px] rounded-frame border border-dashed border-control bg-subtle px-[32px] py-[40px]">
        <h2 className="mb-[6px] text-section font-bold">{t('No agent key yet')}</h2>
        <p className="mb-[18px] text-body text-muted">
          {t(
            'Make one for each agent: Claude Code on a laptop, a job of your CI, a cloud agent. Revoking one stops that agent alone.',
          )}
        </p>
        {action}
      </div>
    );

  const soon = keys.flatMap((key) => {
    const end = keyEnd(key, now);

    return end.state === 'soon' ? [{ key, days: end.days }] : [];
  });

  return (
    <>
      {soon.length === 0 ? null : (
        <Callout className="mb-[20px] max-w-[900px]">
          <p className="text-body">
            {soon.length === 1
              ? t(
                  '« {name} » ends in {count} days. Its agent stops then: make a new key, give it to the agent, then revoke this one.',
                  { name: soon[0]?.key.name ?? '', count: soon[0]?.days ?? 0 },
                )
              : t(
                  '{count} keys end within 7 days. Their agents stop then: make new keys, give them to the agents, then revoke the old ones.',
                  { count: soon.length },
                )}
          </p>
        </Callout>
      )}
      <ul aria-label={t('Agent keys')} className="overflow-hidden rounded-frame border border-line">
        {keys.map((key) => (
          <KeyRow key={key.id} agentKey={key} now={now} onRevoked={() => onRevoked(key)} />
        ))}
      </ul>
      <p className="mt-[10px] text-hint text-muted">
        {keys.length >= MAX_AGENT_KEYS
          ? t('A workspace holds 20 keys at most. Revoke one to make another.')
          : t('{count} of 20 keys.', { count: keys.length })}{' '}
        {t('An app connected with OAuth, as a connector of claude.ai, is listed here too: it has no key to copy.')}
      </p>
    </>
  );
}

const KEY_NOT_REVOKED = msg('The key was not revoked. Try again.');

function KeyRow({ agentKey: key, now, onRevoked }: { agentKey: AgentKey; now: number; onRevoked: () => void }) {
  useLocale();
  const { workspace } = useWorkspace();
  const [open, setOpen] = useState(false);
  const [problem, setProblem] = useState<string | undefined>();
  const end = keyEnd(key, now);
  const panel = `writes-${key.id}`;

  async function revoke() {
    setProblem(undefined);
    const answer = await revokeAgentKey(workspace.id, key.id);
    // A key already gone is what was asked.
    if (answer.ok || answer.status === 404) return onRevoked();
    setProblem(problemOf(answer, MAKE_PROBLEMS, KEY_NOT_REVOKED));
  }

  const label = 'min-w-[110px] text-hint text-muted xl:sr-only';

  return (
    <li className="border-b border-line px-[20px] py-[14px] text-table last:border-b-0">
      <div className="grid grid-cols-1 gap-[6px] xl:grid-cols-[minmax(160px,1.2fr)_minmax(140px,1fr)_minmax(190px,1.3fr)_minmax(110px,0.7fr)_minmax(130px,0.8fr)_auto] xl:items-center xl:gap-[12px]">
        <div className="min-w-0">
          <h2 className="text-body font-bold [overflow-wrap:anywhere]">{key.name}</h2>
          {/* A connection of OAuth (FRU-467): the host its codes went to, the name a person approved. */}
          {key.client ? (
            <span className="mt-[2px] inline-block rounded-full bg-chip px-[8px] py-[2px] text-hint font-semibold text-ink-soft">
              {t('OAuth · {host}', { host: key.client.host })}
            </span>
          ) : null}
          <p className="text-hint text-muted">
            {key.client
              ? t('Approved on {day}', { day: dayOf(key.createdAt) })
              : t('Made on {day}', { day: dayOf(key.createdAt) })}
          </p>
        </div>
        <dl className="contents">
          <div className="flex min-w-0 gap-[8px]">
            <dt className={label}>{t('Sites')}</dt>
            <dd className="min-w-0 [overflow-wrap:anywhere]">
              {key.sites.map((site) => (
                <span key={site.id} className="block">
                  {siteName(site.origin)}
                </span>
              ))}
            </dd>
          </div>
          <div className="flex min-w-0 gap-[8px]">
            <dt className={label}>{t('Can')}</dt>
            <dd>
              {key.rights === 'write' ? t('Read, reply and set a status') : t('Read the notes')}
              <span className="block text-hint text-muted">
                {key.verifiedOnly ? t('Notes of known people only') : t('Every note, a visitor’s too')}
              </span>
            </dd>
          </div>
          <div className="flex min-w-0 gap-[8px]">
            <dt className={label}>{t('Last used')}</dt>
            <dd className={key.lastUsedAt ? '' : 'text-muted'}>
              {key.lastUsedAt ? ago(key.lastUsedAt, now) : t('Never used')}
            </dd>
          </div>
          <div className="flex min-w-0 gap-[8px]">
            <dt className={label}>{t('Ends')}</dt>
            <dd>
              {end.state === 'soon' ? (
                <>
                  <span className="font-semibold text-accent-strong">
                    {t('Ends in {count} days', { count: end.days })}
                  </span>
                  <span className="block text-hint text-muted">{dayOf(key.expiresAt)}</span>
                </>
              ) : null}
              {end.state === 'ended' ? (
                <>
                  <span className="rounded-full bg-chip px-[8px] py-[2px] text-hint font-semibold text-ink-soft">
                    {t('Ended')}
                  </span>
                  <span className="block text-hint text-muted">{t('On {day}', { day: dayOf(key.expiresAt) })}</span>
                </>
              ) : null}
              {end.state === 'ok' ? dayOf(key.expiresAt) : null}
            </dd>
          </div>
        </dl>
        <div className="flex flex-wrap items-center gap-[6px] xl:justify-end">
          <Button
            tone="outline"
            expanded={open}
            {...(open ? { controls: panel } : {})}
            className={open ? 'bg-chip' : ''}
            onClick={() => setOpen(!open)}
          >
            {t('Writes')}
          </Button>
          <Confirm
            label={t('Revoke')}
            confirmLabel={t('Revoke « {name} »', { name: key.name })}
            consequence={
              key.client
                ? t(
                    '{host} is refused from its next request, and its tokens never work again. To connect it again, its connector asks you again. What it wrote stays in the threads of the notes.',
                    { host: key.client.host },
                  )
                : t(
                    'An agent that uses this key is refused from its next request, and the key never works again. What it wrote stays in the threads of the notes.',
                  )
            }
            onConfirm={() => void revoke()}
          />
        </div>
      </div>
      {problem === undefined ? null : (
        <div className="mt-[10px]">
          <Problem>{t(problem)}</Problem>
        </div>
      )}
      {open ? <Writes id={panel} agentKey={key} /> : null}
    </li>
  );
}

const STAGE_KEYS: readonly string[] = STAGES;

/** What a key wrote, read when its row unfolds. */
function Writes({ id, agentKey: key }: { id: string; agentKey: AgentKey }) {
  useLocale();
  const { workspace } = useWorkspace();
  const [writes, setWrites] = useState<Listed<AgentWrite>>('loading');

  const read = useCallback(async () => {
    setWrites('loading');
    setWrites(listedOf(await agentWrites(workspace.id, key.id), (data) => data.writes));
  }, [workspace.id, key.id]);

  useEffect(() => void read(), [read]);

  const hostOf = (site: string) => {
    const named = key.sites.find((each) => each.id === site);

    return named === undefined ? site : siteName(named.origin);
  };
  const what = (write: AgentWrite) => {
    if (write.action === 'reply') return t('Replied to a note');
    const status = statusKey(write.status);

    return t('Set the status to « {status} »', {
      status: STAGE_KEYS.includes(status) ? t(STAGE_NAMES[status as Stage]) : status,
    });
  };

  return (
    <div
      id={id}
      role="region"
      aria-label={t('Writes of {name}', { name: key.name })}
      className="mt-[12px] rounded-box border border-line bg-subtle px-[18px] py-[16px]"
    >
      <h3 className="mb-[8px] text-body font-bold">{t('What this key wrote')}</h3>
      {writes === 'loading' ? <p className="text-small text-muted">{t('Loading…')}</p> : null}
      {writes === 'failed' ? (
        <div role="alert" className="flex flex-wrap items-center gap-[12px]">
          <p className="text-small">{t('The writes of this key did not load.')}</p>
          <Button tone="outline" onClick={() => void read()}>
            {t('Try again')}
          </Button>
        </div>
      ) : null}
      {Array.isArray(writes) && writes.length === 0 ? (
        <p className="text-small text-muted">{t('This key wrote nothing yet. A key that only reads never writes.')}</p>
      ) : null}
      {Array.isArray(writes) && writes.length > 0 ? (
        <>
          <ol>
            {writes.map((write, index) => (
              <li
                key={`${write.at}-${index}`}
                className="grid grid-cols-1 gap-[2px] border-t border-line py-[8px] first:border-t-0 md:grid-cols-[minmax(200px,1.4fr)_minmax(140px,1fr)_minmax(110px,auto)_110px] md:gap-[12px]"
              >
                <span>{what(write)}</span>
                <span className="[overflow-wrap:anywhere]">{hostOf(write.site)}</span>
                <code className="font-mono text-hint">{write.note}</code>
                <span className="text-muted md:text-right">{ago(write.at)}</span>
              </li>
            ))}
          </ol>
          <p className="mt-[8px] text-hint text-muted">
            {writes.length >= AGENT_WRITES_LISTED
              ? t('The last 100 writes are listed.')
              : t(
                  'A reply shows in the thread of its note as « Agent », beside the name of the key. A status can be set back on the page of the note.',
                )}
          </p>
        </>
      ) : null}
    </div>
  );
}
