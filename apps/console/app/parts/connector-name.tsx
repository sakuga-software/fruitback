import { type FormEvent, useState } from 'react';
import { type Connector, call } from '../api';
import { msg, t } from '../i18n';
import { problemOf } from '../problems';
import { Button, Field, LinkButton, Problem } from '../ui';
import { useLocale } from '../use-locale';
import { KINDS, connectorName } from './connector-parts';

/** What a refused name means for the person. */
const RENAME_PROBLEMS: Readonly<Record<string, string>> = {
  'invalid-name': msg('A name of one line, up to 80 characters.'),
  forbidden: msg('Only an owner or an admin of the workspace renames a connector.'),
  'not-found': msg('This connector is not connected any more. Reload the page.'),
};
const NOT_RENAMED = msg('The connector was not renamed. Try again.');

/**
 * The name of a source, at the top of its panel (FRU-404). Several sources can reach one tracker, so
 * an owner or an admin names each one, and « Rename » changes it in place, as for a workspace. An
 * empty name gives the source back the name of its kind.
 *
 * Escape closes the form and is stopped there: the panel would close on it too.
 */
export function ConnectorName({
  base,
  connector,
  manages,
  onRenamed,
}: {
  base: string;
  connector: Connector;
  manages: boolean;
  onRenamed: () => Promise<void>;
}) {
  useLocale();
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(connector.name ?? '');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | undefined>();
  // Set once the form closed: « Rename » then takes focus again, where the keyboard left it.
  const [back, setBack] = useState(false);
  const kind = t(KINDS[connector.kind].name);

  function close() {
    setRenaming(false);
    setProblem(undefined);
    setBack(true);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (name.trim() === (connector.name ?? '')) return close();
    setBusy(true);
    setProblem(undefined);
    const renamed = await call<Connector>('POST', `${base}/connectors/${connector.id}`, { name: name.trim() });
    // A refusal keeps the form open, with the name as it was typed.
    if (!renamed.ok) {
      setBusy(false);
      return setProblem(problemOf(renamed, RENAME_PROBLEMS, NOT_RENAMED));
    }
    await onRenamed();
    setBusy(false);
    close();
  }

  if (renaming)
    return (
      <form
        noValidate
        onSubmit={(event) => void submit(event)}
        onKeyDown={(event) => {
          if (event.key !== 'Escape') return;
          // `Opened` already ignores an Escape that is prevented; stopping it too keeps any other
          // handler above from reading it.
          event.preventDefault();
          event.stopPropagation();
          setName(connector.name ?? '');
          close();
        }}
        className="flex flex-col gap-[12px] px-[22px] pt-[16px]"
      >
        <div className="flex flex-wrap items-end gap-x-[20px] gap-y-[10px]">
          <div className="min-w-0 flex-1 basis-60">
            <Field
              label={t('Name of this connector')}
              hint={t('Empty, it is named {kind}.', { kind })}
              value={name}
              placeholder={kind}
              onChange={(event) => setName(event.target.value)}
              maxLength={80}
              autoFocus
            />
          </div>
          <Button type="submit" disabled={busy}>
            {t('Save')}
          </Button>
          <LinkButton
            space="loose"
            onClick={() => {
              setName(connector.name ?? '');
              close();
            }}
          >
            {t('Cancel')}
          </LinkButton>
        </div>
        {problem === undefined ? null : <Problem>{t(problem)}</Problem>}
      </form>
    );

  return (
    <p className="flex flex-wrap items-baseline gap-x-[12px] gap-y-[4px] px-[22px] pt-[16px] text-body">
      <span className="min-w-0 font-semibold [overflow-wrap:anywhere]">{connectorName(connector)}</span>
      {manages ? (
        <LinkButton
          space="flush"
          autoFocus={back}
          onClick={() => {
            // The name as the last read of the list says it: another admin may have changed it.
            setName(connector.name ?? '');
            setRenaming(true);
          }}
        >
          {t('Rename')}
          <span className="sr-only"> {connectorName(connector)}</span>
        </LinkButton>
      ) : null}
    </p>
  );
}
