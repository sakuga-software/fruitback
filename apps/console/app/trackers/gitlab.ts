import { msg } from '../i18n.ts';
import type { ConsoleTracker } from './plugin.ts';

/**
 * The connector GitLab (FRU-623), as the console draws it: a project of gitlab.com or of a GitLab
 * that the team hosts, by an access token. The worker names it `GitLab · <host of the instance>`.
 */
export const tracker: ConsoleTracker | undefined = {
  kind: 'gitlab',
  detail: msg('An issue in a project, cloud or self-managed.'),
  // The logo of GitLab, from simple-icons 15.0.0 (CC0-1.0), as `connector-marks.tsx` drew it before.
  mark: {
    box: 24,
    path: 'm23.6004 9.5927-.0337-.0862L20.3.9814a.851.851 0 0 0-.3362-.405.8748.8748 0 0 0-.9997.0539.8748.8748 0 0 0-.29.4399l-2.2055 6.748H7.5375l-2.2057-6.748a.8573.8573 0 0 0-.29-.4412.8748.8748 0 0 0-.9997-.0537.8585.8585 0 0 0-.3362.4049L.4332 9.5015l-.0325.0862a6.0657 6.0657 0 0 0 2.0119 7.0105l.0113.0087.03.0213 4.976 3.7264 2.462 1.8633 1.4995 1.1321a1.0085 1.0085 0 0 0 1.2197 0l1.4995-1.1321 2.4619-1.8633 5.006-3.7489.0125-.01a6.0682 6.0682 0 0 0 2.0094-7.003z',
  },
  tokenFields: [
    {
      name: 'url',
      label: msg('GitLab address (optional)'),
      type: 'url',
      placeholder: 'https://gitlab.com',
      hint: msg('Leave it empty for gitlab.com. For a self-managed GitLab, its https:// address.'),
      optional: true,
    },
    {
      name: 'token',
      label: msg('Access token'),
      type: 'password',
      placeholder: 'glpat-…',
      hint: msg('A project access token, with the api scope and the Reporter role. Fruitback keeps it encrypted.'),
    },
  ],
  problems: {
    'invalid-address': msg(
      'Fruitback cannot reach this address. Leave it empty for gitlab.com, or give the https:// address of a GitLab that the internet reaches.',
    ),
    'invalid-token': msg('This is not an access token of GitLab. Copy it again from GitLab, then paste it here.'),
    'key-refused': msg('GitLab refused this token: it is wrong, expired or revoked. Create a new one, then try again.'),
  },
  attention: {
    'key-refused': msg(
      'GitLab refuses the token since {when}: it expired or was revoked, and the notes of its sites do not reach GitLab. Create a new token, disconnect this connector, then connect GitLab again with it.',
    ),
    'key-lacks-access': msg(
      'Since {when}, GitLab refuses a project that a site sends to, and its notes do not reach GitLab. Give the token the Reporter role on that project again, or choose another project here.',
    ),
  },
  sourceLine: (label) => label.replace(/^GitLab · /, ''),
};
