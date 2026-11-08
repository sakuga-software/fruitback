import { msg, t } from '../i18n.ts';
import type { ConsoleTracker } from './plugin.ts';

/**
 * Jira Cloud (FRU-622), as the console draws it. It connects by consent at Atlassian only: the worker
 * takes no API token (`apps/worker/src/trackers/jira.ts` says why). The worker names a connector
 * after the Jira sites of the consent: `Jira · acme`, or `Jira · acme +1` for two.
 */
export const tracker: ConsoleTracker | undefined = {
  kind: 'jira',
  detail: msg('An issue per note, in the Jira Cloud project you choose, with the files of the note.'),
  // The logo of Jira, from simple-icons 15.0.0 (CC0-1.0), as `connector-marks.tsx` draws it.
  mark: {
    box: 24,
    path: 'M11.571 11.513H0a5.218 5.218 0 0 0 5.232 5.215h2.13v2.057A5.215 5.215 0 0 0 12.575 24V12.518a1.005 1.005 0 0 0-1.005-1.005zm5.723-5.756H5.736a5.215 5.215 0 0 0 5.215 5.214h2.129v2.058a5.218 5.218 0 0 0 5.215 5.214V6.758a1.001 1.001 0 0 0-1.001-1.001zM23.013 0H11.455a5.215 5.215 0 0 0 5.215 5.215h2.129v2.057A5.215 5.215 0 0 0 24 12.483V1.005A1.001 1.001 0 0 0 23.013 0Z',
  },
  sourceLine: (label) => t('Site {name}', { name: label.replace(/^Jira · /, '') }),
};
