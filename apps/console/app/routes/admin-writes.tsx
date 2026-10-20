import { type ReactNode, useEffect, useRef, useState } from 'react';
import type { Answer } from '../api';
import { msg, t } from '../i18n';
import { problemOf } from '../problems';
import { Button, Problem } from '../ui';
import { useLocale } from '../use-locale';

/**
 * A write of an administrator of the instance in a workspace they are not a member of (FRU-283,
 * « Directes, tracées »): a button, then what to fill in, what the write does and that the owners
 * read it, « Keep it » and the button that sends. Nothing is sent before that last press.
 *
 * - « Keep it » and Escape put the first button back, with focus on it, and send nothing. Escape
 *   stops here: the panel around it stays open.
 * - A refusal is said under the fields, and what was typed stays.
 * - After a `200`, `onDone` takes the answer, and the first button comes back.
 */

/** The refusals that every write in a workspace can get, beside its own. */
export const IN_WORKSPACE_PROBLEMS: Readonly<Record<string, string>> = {
  'workspace-suspended': msg('This workspace is suspended. Restore it first.'),
  'not-found': msg('This workspace no longer exists, or you are no longer an instance admin.'),
};

export function AdminWrite<T>({
  label,
  name,
  fields,
  consequence,
  confirmLabel,
  ready,
  send,
  problems,
  notDone,
  onDone,
  onClose,
}: {
  /** The first button: « Change the owner ». */
  label: string;
  /** The name of the group, for a screen reader: « Change the owner of Acme ». */
  name: string;
  fields: ReactNode;
  /** What the write does, and that the owners read it. */
  consequence: string;
  /** The button that sends. */
  confirmLabel: string;
  /** Whether what was typed can be sent. */
  ready: boolean;
  send: () => Promise<Answer<T>>;
  problems: Readonly<Record<string, string>>;
  notDone: string;
  onDone: (data: T) => void;
  /** Called when the fields close without a write: the caller empties them. */
  onClose?: () => void;
}) {
  useLocale();
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | undefined>();
  // A second press of the button that sends comes before React draws the first one as busy.
  const sending = useRef(false);
  const back = useRef(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (asking || problem !== undefined) box.current?.scrollIntoView({ block: 'nearest' });
  }, [asking, problem]);

  useEffect(() => {
    if (!back.current || asking) return;
    back.current = false;
    box.current?.querySelector<HTMLElement>('button')?.focus();
  }, [asking]);

  const close = () => {
    back.current = true;
    setProblem(undefined);
    setAsking(false);
    onClose?.();
  };

  async function confirm() {
    if (sending.current || !ready) return;
    sending.current = true;
    setBusy(true);
    setProblem(undefined);
    const answer = await send();
    sending.current = false;
    setBusy(false);
    if (!answer.ok) {
      setProblem(problemOf(answer, { ...IN_WORKSPACE_PROBLEMS, ...problems }, notDone));

      return;
    }
    onDone(answer.data);
    close();
  }

  return (
    <div ref={box} className="flex w-full flex-col gap-[10px] text-small">
      {asking ? (
        <div
          role="group"
          aria-label={name}
          className="flex flex-col gap-[10px]"
          onKeyDown={(event) => {
            if (event.key !== 'Escape') return;
            event.preventDefault();
            event.stopPropagation();
            close();
          }}
        >
          {fields}
          <p>{consequence}</p>
          <span className="flex flex-wrap gap-[8px]">
            <Button tone="quiet" onClick={close}>
              {t('Keep it')}
            </Button>
            <Button tone="primary" size="panel" disabled={busy || !ready} onClick={() => void confirm()}>
              {confirmLabel}
            </Button>
          </span>
        </div>
      ) : (
        <div>
          <Button tone="outline" onClick={() => setAsking(true)}>
            {label}
          </Button>
        </div>
      )}
      {problem === undefined ? null : <Problem>{t(problem)}</Problem>}
    </div>
  );
}

/** The roles an administrator gives (`ADMIN_GIVEN_ROLES` of the worker), as the screens name them. */
export const GIVEN_ROLES = [
  { value: 'member', label: msg('Member') },
  { value: 'admin', label: msg('Admin') },
  { value: 'owner', label: msg('Owner') },
] as const;

/** The roles of an invitation by an administrator (`ADMIN_INVITED_ROLES` of the worker). */
export const INVITED_ROLES = [
  { value: 'member', label: msg('Member') },
  { value: 'admin', label: msg('Admin') },
] as const;
