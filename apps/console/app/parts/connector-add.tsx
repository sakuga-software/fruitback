import { type FormEvent, useState } from 'react';
import { type Connector, call } from '../api';
import { msg, t } from '../i18n';
import { copyText, writeProblemOf } from '../problems';
import { Button, Field, LinkButton, Problem } from '../ui';
import { useLocale } from '../use-locale';
import { KEY_PROBLEMS } from './connector-parts';

/**
 * The two forms that connect a source (FRU-246): a Linear by its API key (FRU-121), and an address of
 * the workspace's own (FRU-132). Each opens under its row of « Add a connector ».
 *
 * WARNING: no failure clears a field. The sentence says the cause, and what was typed stays.
 */

/** What a refused address means for the person, and what to do. */
const ADDRESS_PROBLEMS: Record<string, string> = {
  'invalid-address': msg(
    'Fruitback cannot send to this address. Use a full https:// address that the internet can reach.',
  ),
  'invalid-secret': msg('A secret is 16 to 256 characters, with no space. Leave it empty and Fruitback creates one.'),
  'connectors-unavailable': msg('This Fruitback cannot keep a key yet. Its operator must set FRUITBACK_SECRETS_KEY.'),
  forbidden: msg('Only an owner or an admin of the workspace adds a connector.'),
};

/** The key is typed once and sent once. Nothing here keeps it, and the worker never answers it. */
export function AddLinear({ base, onDone }: { base: string; onDone: (connector: Connector | undefined) => void }) {
  useLocale();
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | undefined>();

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setProblem(undefined);
    const added = await call<Connector>('POST', `${base}/connectors`, { kind: 'linear', apiKey });
    setBusy(false);
    if (added.ok) return onDone(added.data);
    setProblem(
      KEY_PROBLEMS[added.error] ?? writeProblemOf(added, msg('The key could not be kept just now. Try again.')),
    );
  }

  return (
    <form onSubmit={submit} className="flex max-w-[520px] flex-col gap-[12px]">
      <Field
        label={t('Linear API key')}
        type="password"
        autoComplete="off"
        placeholder="lin_api_…"
        value={apiKey}
        onChange={(event) => setApiKey(event.target.value)}
        hint={t('A personal API key, from Linear, Settings, Security and access. Fruitback keeps it encrypted.')}
      />
      {problem === undefined ? null : <Problem>{t(problem)}</Problem>}
      <div className="flex flex-wrap items-center gap-x-[16px] gap-y-[8px]">
        <Button type="submit" size="panel" disabled={busy || apiKey.trim() === ''}>
          {busy ? t('Checking…') : t('Connect')}
        </Button>
        <LinkButton onClick={() => onDone(undefined)}>{t('Cancel')}</LinkButton>
      </div>
    </form>
  );
}

/**
 * The address is typed once and sent once, like a key. A secret that Fruitback made is shown here
 * once: the worker answers it when the connector is made, and never again.
 */
export function AddRest({
  base,
  onAdded,
  onDone,
}: {
  base: string;
  onAdded: (connector: Connector) => void;
  onDone: () => void;
}) {
  useLocale();
  const [url, setUrl] = useState('');
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | undefined>();
  const [made, setMade] = useState<string | undefined>();
  const [copied, setCopied] = useState<'no' | 'yes' | 'refused'>('no');

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setProblem(undefined);
    const added = await call<Connector & { secret?: string }>('POST', `${base}/connectors`, {
      kind: 'rest',
      url,
      ...(secret.trim() === '' ? {} : { secret: secret.trim() }),
    });
    setBusy(false);
    if (!added.ok) {
      return setProblem(
        ADDRESS_PROBLEMS[added.error] ??
          writeProblemOf(added, msg('The address could not be kept just now. Try again.')),
      );
    }
    // The secret stays here: the screen is handed the connector without it, and can keep none.
    const { secret: fresh, ...connector } = added.data;
    onAdded(connector);
    // A secret the person gave is theirs already: nothing is left to show.
    if (fresh === undefined) return onDone();
    setMade(fresh);
  }

  if (made !== undefined) {
    return (
      <div className="flex max-w-[520px] flex-col gap-[8px]">
        <p className="text-small font-semibold">{t('Copy this secret now')}</p>
        <p className="text-hint text-muted">
          {t('Your receiver checks each request with it. Fruitback does not show it again.')}
        </p>
        <code className="block rounded-button bg-chip px-[12px] py-[8px] font-mono text-tiny break-all" data-secret>
          {made}
        </code>
        <div className="flex flex-wrap items-center gap-[8px]">
          <Button
            tone="outline"
            onClick={() => void copyText(made).then((taken) => setCopied(taken ? 'yes' : 'refused'))}
          >
            {copied === 'yes' ? t('Copied') : t('Copy')}
          </Button>
          <Button size="panel" onClick={onDone}>
            {t('I kept it')}
          </Button>
        </div>
        {/* A clipboard can refuse. The secret is on the screen, to select by hand, and this says so. */}
        {copied === 'refused' ? (
          <p role="alert" className="text-hint text-muted">
            {t('The browser refused the copy. Select the secret above and copy it by hand.')}
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="flex max-w-[520px] flex-col gap-[12px]">
      <Field
        label={t('Address of your receiver')}
        type="url"
        autoComplete="off"
        placeholder="https://hooks.acme.dev/fruitback"
        value={url}
        onChange={(event) => setUrl(event.target.value)}
        hint={t('Each note is posted there, signed. The notes stay in Fruitback too.')}
      />
      <Field
        label={t('Secret (optional)')}
        type="password"
        autoComplete="off"
        value={secret}
        onChange={(event) => setSecret(event.target.value)}
        hint={t('Leave it empty and Fruitback creates one, shown once.')}
      />
      {problem === undefined ? null : <Problem>{t(problem)}</Problem>}
      <div className="flex flex-wrap items-center gap-x-[16px] gap-y-[8px]">
        <Button type="submit" size="panel" disabled={busy || url.trim() === ''}>
          {busy ? t('Checking…') : t('Connect')}
        </Button>
        <LinkButton onClick={onDone}>{t('Cancel')}</LinkButton>
      </div>
    </form>
  );
}

/** What a refused routine means for the person, and what to do (FRU-594). */
const ROUTINE_PROBLEMS: Record<string, string> = {
  'invalid-fire-url': msg(
    'This is not the Fire URL of a routine. Copy it from claude.ai/code/routines: it starts with https://api.anthropic.com/v1/claude_code/routines/.',
  ),
  'invalid-token': msg(
    'This is not a token of a routine. Generate one in the API trigger of the routine, and paste it.',
  ),
  'connectors-unavailable': msg('This Fruitback cannot keep a key yet. Its operator must set FRUITBACK_SECRETS_KEY.'),
  forbidden: msg('Only an owner or an admin of the workspace adds a connector.'),
};

/**
 * A Claude Code routine (FRU-594): its Fire URL and its token, typed once and sent once. The worker
 * keeps the token encrypted and never answers it. Nothing is asked of Anthropic here: a call would
 * start a run, so the first call of a trigger says whether the token works.
 */
export function AddRoutine({ base, onDone }: { base: string; onDone: (connector: Connector | undefined) => void }) {
  useLocale();
  const [url, setUrl] = useState('');
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | undefined>();

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setProblem(undefined);
    const added = await call<Connector>('POST', `${base}/connectors`, { kind: 'claude-routine', url, token });
    setBusy(false);
    if (added.ok) return onDone(added.data);
    setProblem(
      ROUTINE_PROBLEMS[added.error] ?? writeProblemOf(added, msg('The routine could not be kept just now. Try again.')),
    );
  }

  return (
    <form onSubmit={submit} className="flex max-w-[520px] flex-col gap-[12px]">
      <Field
        label={t('Fire URL')}
        type="url"
        autoComplete="off"
        placeholder="https://api.anthropic.com/v1/claude_code/routines/trig_…/fire"
        value={url}
        onChange={(event) => setUrl(event.target.value)}
        hint={t('In the routine, at claude.ai/code/routines: Edit, then Trigger, then API.')}
      />
      <Field
        label={t('Token')}
        type="password"
        autoComplete="off"
        placeholder="sk-ant-oat01-…"
        value={token}
        onChange={(event) => setToken(event.target.value)}
        hint={t(
          'Shown once by claude.ai when you generate it. It starts this routine only. Fruitback keeps it encrypted.',
        )}
      />
      {problem === undefined ? null : <Problem>{t(problem)}</Problem>}
      <div className="flex flex-wrap items-center gap-x-[16px] gap-y-[8px]">
        <Button type="submit" size="panel" disabled={busy || url.trim() === '' || token.trim() === ''}>
          {busy ? t('Checking…') : t('Connect')}
        </Button>
        <LinkButton onClick={() => onDone(undefined)}>{t('Cancel')}</LinkButton>
      </div>
    </form>
  );
}
