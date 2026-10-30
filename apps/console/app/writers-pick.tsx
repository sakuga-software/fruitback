import type { Visibility, Writers } from './api';
import { t } from './i18n';
import { Pick } from './ui';
import { useLocale } from './use-locale';

/**
 * « Who can leave a note » (FRU-330), under « Who sees the notes? »: shown only for a site that its
 * members read, where it decides something. A site that everyone reads takes a note from anybody.
 *
 * WARNING: private mode carries no session. The detail of « Members only » says so: a site that a
 * reviewer opens in private mode takes no note unless it says « Anyone on the page ».
 */
export function WritersPick({
  visibility,
  value,
  onChange,
}: {
  visibility: Visibility;
  value: Writers;
  onChange: (writers: Writers) => void;
}) {
  useLocale();
  if (visibility !== 'members') return null;

  return (
    <Pick
      label={t('Who can leave a note?')}
      value={value}
      onChange={onChange}
      options={[
        {
          value: 'members',
          label: t('Members only'),
          detail: t(
            'A note needs the extension, connected by a member. In private mode the extension holds no session, so a site you review in private mode needs « Anyone on the page ».',
          ),
        },
        {
          value: 'anyone',
          label: t('Anyone on the page'),
          detail: t('A visitor leaves a note and cannot read it back. Your members find it.'),
        },
      ]}
    />
  );
}
