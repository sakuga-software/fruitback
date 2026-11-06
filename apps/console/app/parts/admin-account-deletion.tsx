import { useEffect, useRef, useState } from 'react';
import { type AdminUser, deleteAccountAsAdmin } from '../api';
import { msg, t } from '../i18n';
import { problemOf } from '../problems';
import { Button, Field, LinkButton, Problem } from '../ui';
import { useLocale } from '../use-locale';

/**
 * « Delete {name}'s account » (FRU-285), in the foot of the panel of a person. It cannot be undone,
 * so it asks for the address of the account, as the worker does: the button that deletes is held
 * until the address is typed.
 *
 * An account that owns a workspace alone is not deleted (decision 3 of 2026-10-19): the panel lists
 * those workspaces, each with a way to change its owner, and the button is held. The worker says the
 * same with `409 sole-owner` when the list was read before a change.
 */

const PROBLEMS: Readonly<Record<string, string>> = {
  'sole-owner': msg('This person owns a workspace alone now. Read Users again, and change its owner first.'),
  'email-mismatch': msg('This is not the address of the account. Type it as it is written.'),
  'self-deletion': msg('You cannot delete your own account. Another instance admin can.'),
  'last-admin': msg('The last instance admin cannot be deleted. Name another admin first.'),
  'not-found': msg('This account no longer exists. Reload the page.'),
};
const NOT_DELETED = msg('The account was not deleted. Try again.');

export function AccountDeletion({
  user,
  held,
  onDeleted,
}: {
  user: AdminUser;
  /** Why the deletion is held before the worker is asked: on yourself, and on the last admin. */
  held: string | undefined;
  onDeleted: (name: string) => void;
}) {
  useLocale();
  const [asking, setAsking] = useState(false);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | undefined>();
  // A second press of the button that deletes comes before React draws the first one as busy.
  const sending = useRef(false);
  const back = useRef(false);
  const box = useRef<HTMLDivElement>(null);
  const name = user.name ?? user.email;
  const alone = user.workspaces.filter((workspace) => workspace.soleOwner === true);
  const matches = typed.trim().toLowerCase() === user.email.toLowerCase();

  useEffect(() => {
    if (asking || problem !== undefined) box.current?.scrollIntoView({ block: 'nearest' });
  }, [asking, problem]);

  useEffect(() => {
    if (!back.current || asking) return;
    back.current = false;
    box.current?.querySelector<HTMLElement>('button')?.focus();
  }, [asking]);

  const keep = () => {
    back.current = true;
    setTyped('');
    setProblem(undefined);
    setAsking(false);
  };

  async function send() {
    if (sending.current || !matches) return;
    sending.current = true;
    setBusy(true);
    setProblem(undefined);
    const answer = await deleteAccountAsAdmin(user.id, typed.trim());
    sending.current = false;
    setBusy(false);
    // The typed address stays after a refusal.
    if (answer.ok) onDeleted(name);
    else setProblem(problemOf(answer, PROBLEMS, NOT_DELETED));
  }

  return (
    <div ref={box} className="flex w-full flex-col gap-[10px] text-small">
      {alone.length === 0 ? null : (
        <div className="flex flex-col gap-[6px]">
          <p>
            {t('{name} owns these workspaces alone. Change the owner of each, or delete it, before the account.', {
              name,
            })}
          </p>
          <ul className="flex flex-col gap-[4px]">
            {alone.map((workspace) => (
              <li key={workspace.id}>
                <LinkButton to={`/admin/workspaces?open=${encodeURIComponent(workspace.id)}`}>
                  {t('Change the owner of {workspace}', { workspace: workspace.name })}
                </LinkButton>
              </li>
            ))}
          </ul>
        </div>
      )}
      {asking ? (
        <div
          role="group"
          aria-label={t("Delete {name}'s account", { name })}
          className="flex flex-col gap-[10px]"
          onKeyDown={(event) => {
            if (event.key !== 'Escape') return;
            // The panel closes on Escape too: this one only steps back from the deletion.
            event.preventDefault();
            event.stopPropagation();
            keep();
          }}
        >
          <p>
            {t(
              "This deletes {name}'s account for good. They are signed out everywhere and leave every workspace. Their notes stay, signed as a former member. The owners of their workspaces see that you did it.",
              { name },
            )}
          </p>
          <Field
            label={t('Type {email} to confirm', { email: user.email })}
            value={typed}
            type="email"
            compact
            autoFocus
            someoneElse
            onChange={(event) => {
              setTyped(event.target.value);
              setProblem(undefined);
            }}
          />
          <span className="flex flex-wrap gap-[8px]">
            <Button tone="quiet" onClick={keep}>
              {t('Keep it')}
            </Button>
            <Button tone="danger" disabled={busy || !matches} onClick={() => void send()}>
              {t("Delete {name}'s account", { name })}
            </Button>
          </span>
        </div>
      ) : (
        <div>
          <Button tone="outline" disabled={held !== undefined || alone.length > 0} onClick={() => setAsking(true)}>
            {t("Delete {name}'s account", { name })}
          </Button>
        </div>
      )}
      {held === undefined ? null : <p className="text-hint text-muted">{t(held)}</p>}
      {problem === undefined ? null : <Problem>{t(problem)}</Problem>}
    </div>
  );
}

/** The two reasons why the deletion is held before the worker is asked, as for « Suspend ». */
export const DELETION_HOLDS = {
  self: msg('You cannot delete your own account. Another instance admin can.'),
  last: msg('The last instance admin cannot be deleted. Name another admin first.'),
};
