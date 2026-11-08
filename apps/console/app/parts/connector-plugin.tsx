import { type FormEvent, useState } from 'react';
import { type Connector, call } from '../api';
import { moment } from '../ago';
import { msg, t } from '../i18n';
import { problemOf, writeProblemOf } from '../problems';
import { useWorkspace } from '../routes/workspace';
import { trackerOf } from '../trackers/index.ts';
import type { ConsoleTracker } from '../trackers/plugin.ts';
import { Button, Choice, Field, LinkButton, Problem, SidePanel } from '../ui';
import { useLocale } from '../use-locale';
import { Disconnect, KINDS, type PanelProps, SendersList, sourceLine } from './connector-parts';
import { LateDeliveries } from './connector-rest';

/**
 * What every connector of a plugin says and does in the console (FRU-621): its form of a token, its
 * way to its service by OAuth and back, and its panel. The name of the service is `{source}`, so a
 * plugin brings only its card (`trackers/<kind>.ts`) and its own French.
 */

/** What the way back from the service says, as the worker words it in the address (`?<kind>=…`). */
export const PLUGIN_RETURNS: Readonly<Record<string, string>> = {
  declined: msg('You declined access in {source}, so it is not connected. Press Connect to try again.'),
  forbidden: msg('Only an owner or an admin of the workspace adds a connector.'),
  suspended: msg('{source} was not connected: this workspace is suspended.'),
  failed: msg('{source} was not connected. Start again from « Connect ».'),
};

/** What a refusal of the form, or of the start of the way to the service, means. */
const PROBLEMS: Readonly<Record<string, string>> = {
  'key-refused': msg('{source} refused this token. Copy it again from {source}, then try again.'),
  'key-lacks-access': msg(
    '{source} knows this token, and it may not reach what Fruitback needs. Check its access, then try again.',
  ),
  'store-unavailable': msg('{source} did not answer just now. Your token is not kept: try again in a minute.'),
  'connectors-unavailable': msg('This Fruitback cannot connect {source} yet. Its operator must set it up.'),
  forbidden: msg('Only an owner or an admin of the workspace adds a connector.'),
};

/** What to do about a connector that its service refuses (FRU-102). `{when}` is the first refusal. */
const ATTENTION: Record<NonNullable<Connector['attention']>['reason'], string> = {
  'key-refused': msg(
    '{source} refuses this connection since {when}, and the notes of its sites do not reach {source}. Disconnect it, then connect {source} again.',
  ),
  'key-lacks-access': msg(
    'Since {when}, {source} refuses a place that a site sends to, and its notes do not reach {source}. Give the connection access to that place in {source}, or choose another one here.',
  ),
  'connection-ended': msg(
    '{source} ended this connection, and since {when} the notes of its sites do not reach {source}. Disconnect it, then connect {source} again.',
  ),
};

/** The name of the service of a plugin, as a screen shows it. */
const nameOf = (tracker: Pick<ConsoleTracker, 'kind'>): string => t(KINDS[tracker.kind].name);

/** The worker says where to go, and the browser goes there: the consent is at the service. */
export async function leaveForPlugin(base: string, tracker: ConsoleTracker): Promise<string | undefined> {
  const asked = await call<{ url: string }>('POST', `${base}/connectors/${tracker.kind}/oauth`);
  if (asked.ok) {
    window.location.assign(asked.data.url);

    return undefined;
  }

  return problemOf(asked, PROBLEMS, msg('Fruitback could not start the connection to {source}. Try again.'));
}

/** A sentence of this file for a plugin: its words, with the name of its service. */
export function pluginSentence(sentence: string, tracker: Pick<ConsoleTracker, 'kind'>): string {
  return t(sentence, { source: nameOf(tracker) });
}

/**
 * The form of a token. What is typed is sent once, and nothing here keeps it: the worker never
 * answers it. No failure clears a field.
 */
export function AddPlugin({
  base,
  tracker,
  onDone,
}: {
  base: string;
  tracker: ConsoleTracker;
  onDone: (connector: Connector | undefined) => void;
}) {
  useLocale();
  const fields = tracker.tokenFields ?? [];
  // A choice starts on its first option: the form sends what the person sees.
  const [values, setValues] = useState<Readonly<Record<string, string>>>(() =>
    Object.fromEntries(
      fields.flatMap((field) => (field.options?.[0] === undefined ? [] : [[field.name, field.options[0].value]])),
    ),
  );
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | undefined>();
  const missing = fields.some((field) => field.optional !== true && (values[field.name] ?? '').trim() === '');

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setProblem(undefined);
    const body = Object.fromEntries(
      fields.flatMap((field) => {
        const value = (values[field.name] ?? '').trim();

        return value === '' ? [] : [[field.name, value]];
      }),
    );
    const added = await call<Connector>('POST', `${base}/connectors`, { ...body, kind: tracker.kind });
    setBusy(false);
    if (added.ok) return onDone(added.data);
    setProblem(
      tracker.problems?.[added.error] ??
        PROBLEMS[added.error] ??
        writeProblemOf(added, msg('The token could not be kept just now. Try again.')),
    );
  }

  return (
    <form onSubmit={submit} className="flex max-w-[520px] flex-col gap-[12px]">
      {fields.map((field) =>
        field.type === 'select' ? (
          <Choice
            key={field.name}
            label={t(field.label)}
            value={values[field.name] ?? ''}
            onChange={(chosen) => setValues((current) => ({ ...current, [field.name]: chosen }))}
            options={(field.options ?? []).map((option) => ({ value: option.value, label: t(option.label) }))}
            {...(field.hint === undefined ? {} : { hint: t(field.hint) })}
          />
        ) : (
          <Field
            key={field.name}
            label={t(field.label)}
            type={field.type}
            autoComplete="off"
            {...(field.placeholder === undefined ? {} : { placeholder: field.placeholder })}
            value={values[field.name] ?? ''}
            onChange={(event) => {
              const typed = event.target.value;
              setValues((current) => ({ ...current, [field.name]: typed }));
            }}
            {...(field.hint === undefined ? {} : { hint: t(field.hint) })}
          />
        ),
      )}
      {problem === undefined ? null : <Problem>{pluginSentence(problem, tracker)}</Problem>}
      <div className="flex flex-wrap items-center gap-x-[16px] gap-y-[8px]">
        <Button type="submit" size="panel" disabled={busy || missing}>
          {busy ? t('Checking…') : t('Connect')}
        </Button>
        <LinkButton onClick={() => onDone(undefined)}>{t('Cancel')}</LinkButton>
      </div>
    </form>
  );
}

/**
 * The panel of a connector of a plugin: the sites that send their notes there (read only: a site
 * chooses its places on the Sites screen, FRU-399), and what to do when the service refuses it.
 */
export function PluginPanel({ id, base, connector, sites, manages, onChanged, onRemoved }: PanelProps) {
  useLocale();
  const { workspace } = useWorkspace();
  const [problem, setProblem] = useState<string | undefined>();
  const source = t(KINDS[connector.kind].name);
  const known = trackerOf(connector.kind) !== undefined;

  async function disconnect() {
    const removed = await call('DELETE', `${base}/connectors/${connector.id}`);
    if (removed.ok) return onRemoved();
    setProblem(writeProblemOf(removed, msg('This connector is still connected. Try again.')));
  }

  return (
    <SidePanel
      id={id}
      flush
      title={source}
      detail={sourceLine(connector)}
      {...(manages
        ? {
            foot: (
              <Disconnect
                label={t('Disconnect {source}', { source })}
                confirmLabel={t('Disconnect {source}', { source: sourceLine(connector) })}
                consequence={t(
                  'Its sites keep their notes in the workspace again. The issues already in {source} stay there.',
                  {
                    source,
                  },
                )}
                onConfirm={() => void disconnect()}
              />
            ),
          }
        : {})}
    >
      {/* A connector of a kind this console does not draw yet: a server of after made it. */}
      {known ? null : <p className="text-hint text-muted">{t('This console does not know this connector yet.')}</p>}
      {connector.attention === undefined ? null : (
        <Problem>
          {t(ATTENTION[connector.attention.reason], { when: moment(connector.attention.since), source })}
        </Problem>
      )}
      <SendersList connector={connector} sites={sites} workspaceId={workspace.id} />
      {/* FRU-624: a connector that receives says the notes that did not arrive, as an address does. */}
      {trackerOf(connector.kind)?.receives ? (
        <LateDeliveries base={base} connector={connector} manages={manages} onChanged={onChanged} source={source} />
      ) : null}
      {problem === undefined ? null : <Problem>{t(problem)}</Problem>}
    </SidePanel>
  );
}
