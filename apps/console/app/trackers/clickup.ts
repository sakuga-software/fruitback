import { msg } from '../i18n.ts';
import type { ConsoleTracker } from './plugin.ts';

/**
 * ClickUp (FRU-625), as the console draws it. It connects by consent at ClickUp where the operator
 * made an app (`FRUITBACK_CLICKUP_OAUTH`), and by a personal token anywhere: ClickUp says the first is
 * for apps that other people use, the second for a team's own use. The worker names a connector after
 * the Workspaces of ClickUp it reaches: `ClickUp · Acme`.
 */
export const tracker: ConsoleTracker | undefined = {
  kind: 'clickup',
  detail: msg('A task per note, in the ClickUp list you choose, with the files of the note.'),
  // The logo of ClickUp, from simple-icons 15.0.0 (CC0-1.0).
  mark: {
    box: 24,
    path: 'M2 18.439l3.69-2.828c1.961 2.56 4.044 3.739 6.363 3.739 2.307 0 4.33-1.166 6.203-3.704L22 18.405C19.298 22.065 15.941 24 12.053 24 8.178 24 4.788 22.078 2 18.439zM12.04 6.15l-6.568 5.66-3.036-3.52L12.055 0l9.543 8.296-3.05 3.509z',
  },
  tokenFields: [
    {
      name: 'token',
      label: msg('ClickUp personal token'),
      type: 'password',
      placeholder: 'pk_…',
      hint: msg('From ClickUp, your avatar, Settings, then Apps: « API Token ». Fruitback keeps it encrypted.'),
    },
  ],
  problems: {
    'invalid-token': msg(
      'A personal token of ClickUp starts with pk_. Copy it again from ClickUp, Settings, then Apps.',
    ),
  },
  // The name of the Workspace of ClickUp alone: « workspace » names a team of Fruitback here.
  sourceLine: (label) => label.replace(/^ClickUp · /, ''),
};
