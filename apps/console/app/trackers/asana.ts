import { msg } from '../i18n.ts';
import type { ConsoleTracker } from './plugin.ts';

/**
 * Asana (FRU-626), as the console draws it. It connects by consent at Asana where the operator made an
 * app (`FRUITBACK_ASANA_OAUTH`), and by a personal access token anywhere. The worker names a connector
 * after the Asana workspaces it reaches: `Asana · Acme`.
 */
export const tracker: ConsoleTracker | undefined = {
  kind: 'asana',
  detail: msg('A task per note, in the Asana project you choose, with the files of the note.'),
  // The logo of Asana, from simple-icons 15.0.0 (CC0-1.0).
  mark: {
    box: 24,
    path: 'M18.78 12.653c-2.882 0-5.22 2.336-5.22 5.22s2.338 5.22 5.22 5.22 5.22-2.34 5.22-5.22-2.336-5.22-5.22-5.22zm-13.56 0c-2.88 0-5.22 2.337-5.22 5.22s2.338 5.22 5.22 5.22 5.22-2.338 5.22-5.22-2.336-5.22-5.22-5.22zm12-6.525c0 2.883-2.337 5.22-5.22 5.22-2.882 0-5.22-2.337-5.22-5.22 0-2.88 2.338-5.22 5.22-5.22 2.883 0 5.22 2.34 5.22 5.22z',
  },
  tokenFields: [
    {
      name: 'token',
      label: msg('Asana personal access token'),
      type: 'password',
      placeholder: '2/…',
      hint: msg('From the developer console of Asana: « Create new token ». Fruitback keeps it encrypted.'),
    },
  ],
  problems: {
    'invalid-token': msg('This is no personal access token of Asana. Copy it again from its developer console.'),
  },
  // The name of the workspace of Asana alone: « workspace » names a team of Fruitback here.
  sourceLine: (label) => label.replace(/^Asana · /, ''),
};
