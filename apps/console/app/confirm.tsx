import { useState } from 'react';
import { t } from './i18n';
import { Button } from './ui';
import { useLocale } from './use-locale';

/**
 * A gesture that cannot be undone asks twice (FRU-165).
 *
 * The first press says what the gesture costs, and shows two buttons: « Keep it », which has focus,
 * and one that names the thing. Only that second button acts. « Keep it » and Escape put the first
 * button back, with focus on it, so a keyboard finds the row as it was. The form is the one of the
 * deletion of a workspace in `account.tsx`.
 */
export function Confirm({
  label,
  confirmLabel,
  consequence,
  onConfirm,
  className = '',
}: {
  /** The first button, e.g. « Remove ». */
  label: string;
  /** The button that acts, which names the thing, e.g. « Remove staging.acme.dev ». */
  confirmLabel: string;
  /** What the gesture costs, said before it is done. */
  consequence: string;
  onConfirm: () => void;
  className?: string;
}) {
  useLocale();
  const [asking, setAsking] = useState(false);
  // Set once the person stepped back: the first button then takes focus again when it reappears.
  const [back, setBack] = useState(false);

  if (!asking)
    return (
      <Button tone="quiet" className={className} autoFocus={back} onClick={() => setAsking(true)}>
        {label}
      </Button>
    );

  const keep = () => {
    setBack(true);
    setAsking(false);
  };

  return <Confirmation confirmLabel={confirmLabel} consequence={consequence} onConfirm={onConfirm} onKeep={keep} />;
}

/**
 * The second time of a gesture that asks twice: what it costs, « Keep it », which has focus, and the
 * button that acts. A screen that asks the first time elsewhere, in a menu, shows this alone, and
 * gives focus back to what opened it in `onKeep`.
 */
export function Confirmation({
  confirmLabel,
  consequence,
  onConfirm,
  onKeep,
  keepLabel,
}: {
  confirmLabel: string;
  consequence: string;
  onConfirm: () => void;
  /** « Keep it », and Escape. */
  onKeep: () => void;
  /** The words of the way back, when « Keep it » does not say it: « Stay signed in ». */
  keepLabel?: string;
}) {
  useLocale();

  return (
    <div
      role="group"
      aria-label={confirmLabel}
      className="flex w-full basis-full flex-wrap items-center gap-2"
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return;
        event.stopPropagation();
        onKeep();
      }}
    >
      <p className="w-full text-sm">{consequence}</p>
      <Button tone="quiet" autoFocus onClick={onKeep}>
        {keepLabel ?? t('Keep it')}
      </Button>
      <Button tone="danger" onClick={onConfirm}>
        {confirmLabel}
      </Button>
    </div>
  );
}
