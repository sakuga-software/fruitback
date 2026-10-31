import { GITHUB_MARK } from './provider-icons';

/**
 * The mark of a kind of source beside its name (FRU-435, FRU-543), drawn inline: no CDN, no request.
 *
 * - Linear, Jira, GitLab, Trello, Notion: their logos, from simple-icons 15.0.0 (`icons/<name>.svg`,
 *   CC0-1.0).
 * - GitHub Issues: the mark of GitHub, the one of the sign-in button (`provider-icons.tsx`).
 * - REST API: two braces, the « { } » that the mockup writes for an address, drawn as lines. A text
 *   would join the words of its cell.
 * - Webhook: the `webhook` icon of Lucide 0.5 (`@iconify-json/lucide`, ISC), drawn as lines too.
 *
 * The name beside it says the kind, so a mark is `aria-hidden` and takes no focus. It takes the colour
 * of the name: one colour for every mark, so that no logo is louder than the state of its row.
 */
export type MarkedKind = 'linear' | 'github' | 'rest';

/** The sources that the Connectors screen lists and that do not exist yet: they have a mark too. */
export type LaterKind = 'jira' | 'gitlab' | 'trello' | 'notion' | 'webhook';

/** A mark: a path in its box, filled, or drawn as lines of 1.5 px at 16 px. */
type Drawn = { box: 16 | 24; path: string; lines?: true };

const MARKS: Readonly<Record<MarkedKind | LaterKind, Drawn>> = {
  linear: {
    box: 24,
    path: 'M2.886 4.18A11.982 11.982 0 0 1 11.99 0C18.624 0 24 5.376 24 12.009c0 3.64-1.62 6.903-4.18 9.105L2.887 4.18ZM1.817 5.626l16.556 16.556c-.524.33-1.075.62-1.65.866L.951 7.277c.247-.575.537-1.126.866-1.65ZM.322 9.163l14.515 14.515c-.71.172-1.443.282-2.195.322L0 11.358a12 12 0 0 1 .322-2.195Zm-.17 4.862 9.823 9.824a12.02 12.02 0 0 1-9.824-9.824Z',
  },
  github: { box: 16, path: GITHUB_MARK },
  rest: {
    box: 16,
    lines: true,
    path: 'M6 2.5c-1.5 0-2 .7-2 2v1.8c0 .9-.5 1.5-1.5 1.7 1 .2 1.5.8 1.5 1.7v1.8c0 1.3.5 2 2 2M10 2.5c1.5 0 2 .7 2 2v1.8c0 .9.5 1.5 1.5 1.7-1 .2-1.5.8-1.5 1.7v1.8c0 1.3-.5 2-2 2',
  },
  jira: {
    box: 24,
    path: 'M11.571 11.513H0a5.218 5.218 0 0 0 5.232 5.215h2.13v2.057A5.215 5.215 0 0 0 12.575 24V12.518a1.005 1.005 0 0 0-1.005-1.005zm5.723-5.756H5.736a5.215 5.215 0 0 0 5.215 5.214h2.129v2.058a5.218 5.218 0 0 0 5.215 5.214V6.758a1.001 1.001 0 0 0-1.001-1.001zM23.013 0H11.455a5.215 5.215 0 0 0 5.215 5.215h2.129v2.057A5.215 5.215 0 0 0 24 12.483V1.005A1.001 1.001 0 0 0 23.013 0Z',
  },
  gitlab: {
    box: 24,
    path: 'm23.6004 9.5927-.0337-.0862L20.3.9814a.851.851 0 0 0-.3362-.405.8748.8748 0 0 0-.9997.0539.8748.8748 0 0 0-.29.4399l-2.2055 6.748H7.5375l-2.2057-6.748a.8573.8573 0 0 0-.29-.4412.8748.8748 0 0 0-.9997-.0537.8585.8585 0 0 0-.3362.4049L.4332 9.5015l-.0325.0862a6.0657 6.0657 0 0 0 2.0119 7.0105l.0113.0087.03.0213 4.976 3.7264 2.462 1.8633 1.4995 1.1321a1.0085 1.0085 0 0 0 1.2197 0l1.4995-1.1321 2.4619-1.8633 5.006-3.7489.0125-.01a6.0682 6.0682 0 0 0 2.0094-7.003z',
  },
  trello: {
    box: 24,
    path: 'M21.147 0H2.853A2.86 2.86 0 000 2.853v18.294A2.86 2.86 0 002.853 24h18.294A2.86 2.86 0 0024 21.147V2.853A2.86 2.86 0 0021.147 0zM10.34 17.287a.953.953 0 01-.953.953h-4a.954.954 0 01-.954-.953V5.38a.953.953 0 01.954-.953h4a.954.954 0 01.953.953zm9.233-5.467a.944.944 0 01-.953.947h-4a.947.947 0 01-.953-.947V5.38a.953.953 0 01.953-.953h4a.954.954 0 01.953.953z',
  },
  notion: {
    box: 24,
    path: 'M4.459 4.208c.746.606 1.026.56 2.428.466l13.215-.793c.28 0 .047-.28-.046-.326L17.86 1.968c-.42-.326-.981-.7-2.055-.607L3.01 2.295c-.466.046-.56.28-.374.466zm.793 3.08v13.904c0 .747.373 1.027 1.214.98l14.523-.84c.841-.046.935-.56.935-1.167V6.354c0-.606-.233-.933-.748-.887l-15.177.887c-.56.047-.747.327-.747.933zm14.337.745c.093.42 0 .84-.42.888l-.7.14v10.264c-.608.327-1.168.514-1.635.514-.748 0-.935-.234-1.495-.933l-4.577-7.186v6.952L12.21 19s0 .84-1.168.84l-3.222.186c-.093-.186 0-.653.327-.746l.84-.233V9.854L7.822 9.76c-.094-.42.14-1.026.793-1.073l3.456-.233 4.764 7.279v-6.44l-1.215-.139c-.093-.514.28-.887.747-.933zM1.936 1.035l13.31-.98c1.634-.14 2.055-.047 3.082.7l4.249 2.986c.7.513.934.653.934 1.213v16.378c0 1.026-.373 1.634-1.68 1.726l-15.458.934c-.98.047-1.448-.093-1.962-.747l-3.129-4.06c-.56-.747-.793-1.306-.793-1.96V2.667c0-.839.374-1.54 1.447-1.632z',
  },
  webhook: {
    box: 24,
    lines: true,
    path: 'M18 16.98h-5.99c-1.1 0-1.95.94-2.48 1.9A4 4 0 0 1 2 17c.01-.7.2-1.4.57-2M6 17l3.13-5.78c.53-.97.1-2.18-.5-3.1a4 4 0 1 1 6.89-4.06M12 6l3.13 5.73C15.66 12.7 16.9 13 18 13a4 4 0 0 1 0 8',
  },
};

/** The mark of a kind of source, 14 px in a cell of a table, or `size` beside the name of a source. */
export function ConnectorMark({ kind, size = 14 }: { kind: MarkedKind | LaterKind; size?: 14 | 18 }) {
  const { box, path, lines } = MARKS[kind];

  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox={`0 0 ${box} ${box}`}
      width={size}
      height={size}
      className={`flex-none ${lines ? '' : 'fill-current'}`}
      data-mark={kind}
    >
      {lines ? (
        <path
          d={path}
          fill="none"
          stroke="currentColor"
          // 1.5 px at 16 px, at every size and in either box.
          strokeWidth={(1.5 * box) / 16}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ) : (
        <path d={path} />
      )}
    </svg>
  );
}
