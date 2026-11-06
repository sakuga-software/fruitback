import { IconButton, PageNumber } from '../ui';
import { t } from '../i18n';
import { useLocale } from '../use-locale';
import { pageWindow } from '../page-window';

/** The pages a press reaches directly (FRU-587), for a list that knows how many pages it has. */
type PageNumbers = {
  /** The page shown, from 1. */
  at: number;
  count: number;
  /** Whether a page has an address: a list read by a cursor knows few of them. Every page when none is given. */
  reach?: (page: number) => boolean;
  onGo: (page: number) => void;
};

/**
 * Where the page is in the list, and the way to the pages around it (FRU-587, Mathieu): « Previous »
 * and « Next » are icon buttons, and between them the numbers of the first page, the last, and the
 * pages beside the one shown (`pageWindow`). The page shown is marked `aria-current`, and stays a
 * button: a press on a number keeps the focus on it once its page is drawn.
 */
export function NotePages({
  label,
  from,
  shown,
  total,
  first,
  last,
  onPage,
  numbers,
  previousIsFirst = false,
}: {
  /** What the pages are of: « Pages of notes » when none is given. */
  label?: string;
  from: number;
  shown: number;
  total: number;
  first: boolean;
  last: boolean;
  onPage: (to: 'next' | 'previous') => void;
  numbers?: PageNumbers;
  /**
   * The page before is not known, and the arrow goes to the first page: a list read by a cursor,
   * opened from a link past its second page. The arrow then says so, and draws « « ».
   */
  previousIsFirst?: boolean;
}) {
  useLocale();

  return (
    <nav
      aria-label={label ?? t('Pages of notes')}
      className="mt-[16px] flex flex-wrap items-center justify-between gap-[12px] text-small text-muted"
    >
      <span className="tabular-nums">{t('{from} to {to} of {total}', { from, to: from + shown - 1, total })}</span>
      <span className="flex items-center gap-[4px]">
        <IconButton
          size="small"
          label={previousIsFirst ? t('First page') : t('Previous page')}
          disabled={first}
          onClick={() => onPage('previous')}
        >
          <Chevron to={previousIsFirst ? 'first' : 'previous'} />
        </IconButton>
        {numbers === undefined
          ? null
          : pageWindow(numbers.at, numbers.count, numbers.reach).map((link, index) =>
              link === 'gap' ? (
                // Its place in the list is its key: two « … » are never at the same place.
                <span key={`gap ${index}`} aria-hidden="true" className="w-[20px] text-center">
                  …
                </span>
              ) : (
                <PageNumber
                  key={link}
                  label={t('Page {page}', { page: link })}
                  current={link === numbers.at}
                  onClick={() => numbers.onGo(link)}
                >
                  {link}
                </PageNumber>
              ),
            )}
        <IconButton size="small" label={t('Next page')} disabled={last} onClick={() => onPage('next')}>
          <Chevron to="next" />
        </IconButton>
      </span>
    </nav>
  );
}

/** The arrow of « Previous page » and « Next page »: the chevron of `Disclosure`, either way; two for « First page ». */
const CHEVRONS = { next: 'M9 6l6 6-6 6', previous: 'M15 6l-6 6 6 6', first: 'M12 6l-6 6 6 6M18 6l-6 6 6 6' } as const;

function Chevron({ to }: { to: keyof typeof CHEVRONS }) {
  return (
    <svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" className="size-[16px]">
      <path
        d={CHEVRONS[to]}
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
