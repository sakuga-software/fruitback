import { type FormEvent, useRef, useState } from 'react';
import { type Me, renameMe, saveLanguage } from '../api';
import { LOCALES, chooseLanguage, locale, msg, t } from '../i18n';
import { problemOf } from '../problems';
import { Choice, Field, Problem } from '../ui';
import { useLocale } from '../use-locale';
import { SectionTitle } from './account-rows';

const NAME_PROBLEMS: Readonly<Record<string, string>> = {
  'invalid-name': msg('A name is one line of 1 to 80 characters.'),
};
const NAME_NOT_KEPT = msg('Your name was not changed. Try again.');

/** The profile of My account (FRU-248): the name on the notes, and the language. */
export function ProfileSection({ me, primary }: { me: Me; primary: string }) {
  useLocale();
  // The name on the notes. What is typed stays when the worker refuses it.
  const [name, setName] = useState(me.account.name ?? '');
  const [nameProblem, setNameProblem] = useState<string | undefined>();
  // The name the worker keeps, and what is in the field now: an answer reads them when it lands, and
  // not as they were when the name left.
  const kept = useRef(me.account.name ?? '');
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
    // What was typed while the name was on its way stays in the field, and leaves in its turn: the
    // answer never writes over it.
    if (typed.current.trim() !== sent) return void saveName();
    setName(kept.current);
  }
  const [unsent, setUnsent] = useState(false);

  return (
    <section aria-labelledby="profile-title" className="flex flex-col gap-[14px]">
      <SectionTitle id="profile-title">{t('Profile')}</SectionTitle>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(240px,100%),1fr))] gap-[14px]">
        {/* Kept when the field is left, or by Enter: the mockup draws no button. */}
        <form onSubmit={(event) => void saveName(event)} onBlur={() => void saveName()} className="min-w-0">
          <Field
            label={t('Name shown on notes')}
            value={name}
            maxLength={80}
            autoComplete="name"
            hint={primary}
            onChange={(event) => setName(event.target.value)}
          />
        </form>
        <div>
          <Choice
            label={t('Language')}
            hint={t('The language of the console, and of the e-mails Fruitback sends you.')}
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
      {nameProblem === undefined ? null : <Problem>{t(nameProblem)}</Problem>}
      {unsent ? (
        <Problem>
          {t(
            'Your account did not take this language yet. It is kept in this browser, and sent again the next time you open the console.',
          )}
        </Problem>
      ) : null}
    </section>
  );
}
