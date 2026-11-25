import { type FormEvent, useRef, useState } from 'react';
import { type Me, renameMe, saveLanguage } from '../api';
import { LOCALES, chooseLanguage, locale, msg, t } from '../i18n';
import { problemOf } from '../problems';
import { Choice, Field, Problem } from '../ui';
import { useLocale } from '../use-locale';
import { SettingsCard } from './account-rows';

const NAME_PROBLEMS: Readonly<Record<string, string>> = {
  'invalid-name': msg('A name is one line of 1 to 80 characters.'),
};
const NAME_NOT_KEPT = msg('Your name was not changed. Try again.');

/**
 * The profile of My account (FRU-248), the first card of the page (FRU-692): who the notes say wrote
 * them, the name on the notes, and the language.
 */
export function ProfileSection({ me, primary }: { me: Me; primary: string }) {
  useLocale();
  // The name on the notes. What is typed stays when the worker refuses it.
  const [name, setName] = useState(me.account.name ?? '');
  const [nameProblem, setNameProblem] = useState<string | undefined>();
  // The name the worker keeps, and what is in the field now: an answer reads them when it lands, and
  // not as they were when the name left.
  const kept = useRef(me.account.name ?? '');
  // The same name, drawn beside the initial: a ref draws nothing when it changes.
  const [shownName, setShownName] = useState(kept.current);
  const typed = useRef(name);
  typed.current = name;
  // One name on its way at a time: Enter, then leaving the field before the answer, sent it twice.
  const saving = useRef(false);
  async function saveName(event?: FormEvent) {
    event?.preventDefault();
    const sent = typed.current.trim();
    if (saving.current || sent === kept.current.trim()) return;
    saving.current = true;
    setNameProblem(undefined);
    const saved = await renameMe(sent);
    saving.current = false;
    if (!saved.ok) {
      // A newer text typed while this one was on its way is sent in its turn: the refusal was of the
      // name before it.
      if (typed.current.trim() !== sent) return void saveName();
      return setNameProblem(problemOf(saved, NAME_PROBLEMS, NAME_NOT_KEPT));
    }
    kept.current = saved.data.account.name ?? sent;
    setShownName(kept.current);
    // What was typed while the name was on its way stays in the field, and leaves in its turn: the
    // answer never writes over it.
    if (typed.current.trim() !== sent) return void saveName();
    setName(kept.current);
  }
  const [unsent, setUnsent] = useState(false);

  // The name the notes show: the one kept, or the address while the account has none.
  const shown = shownName.trim() === '' ? primary : shownName;

  return (
    <SettingsCard id="profile-title" icon="profile" title={t('Profile')}>
      <div className="flex items-center gap-[16px] px-[16px] pt-[4px] pb-[18px]">
        <span
          aria-hidden="true"
          className="kit-profile-avatar inline-flex size-[56px] flex-none items-center justify-center rounded-pill bg-avatar text-[26px] leading-none font-semibold text-on-ink"
        >
          {shown.trim().charAt(0).toUpperCase() || '?'}
        </span>
        <span className="flex min-w-0 flex-col gap-[4px]">
          <span className="text-small leading-auto font-semibold [overflow-wrap:anywhere]">{shown}</span>
          {/* The address under the name, once: an account with no name shows its address above. */}
          {shown === primary ? null : <span className="text-hint text-muted [overflow-wrap:anywhere]">{primary}</span>}
        </span>
      </div>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(180px,100%),1fr))] gap-[16px] px-[16px] pb-[18px]">
        {/* Kept when the field is left, or by Enter: the mockup draws no button. */}
        <form onSubmit={(event) => void saveName(event)} onBlur={() => void saveName()} className="min-w-0">
          <Field
            label={t('Name shown on notes')}
            value={name}
            maxLength={80}
            autoComplete="name"
            onChange={(event) => setName(event.target.value)}
          />
        </form>
        <div className="min-w-0">
          <Choice
            label={t('Language')}
            value={locale()}
            options={LOCALES.map((each) => ({ value: each.tag, label: each.name }))}
            onChange={(tag) => {
              // The screen changes at once. The account keeps the choice for the e-mails and for
              // the next browser. When it did not hear it, say so: the choice stays in this browser
              // and is sent again at the next visit.
              setUnsent(false);
              void chooseLanguage(tag, saveLanguage).then((heard) => setUnsent(!heard));
            }}
          />
        </div>
      </div>
      {nameProblem === undefined && !unsent ? null : (
        <div className="flex flex-col gap-[8px] px-[16px] pb-[16px]">
          {nameProblem === undefined ? null : <Problem>{t(nameProblem)}</Problem>}
          {unsent ? (
            <Problem>
              {t(
                'Your account did not take this language yet. It is kept in this browser, and sent again the next time you open the console.',
              )}
            </Problem>
          ) : null}
        </div>
      )}
    </SettingsCard>
  );
}
