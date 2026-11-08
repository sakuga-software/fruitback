import { msg } from '../i18n.ts';
import type { ConsoleTracker } from './plugin.ts';

/**
 * The connector Slack (FRU-624), as the console draws it: an Incoming Webhook that posts each note,
 * or each verified note, in its channel. The notes stay in Fruitback, so its panel lists the ones that
 * did not reach Slack, as the panel of a REST address does.
 */
export const tracker: ConsoleTracker | undefined = {
  kind: 'slack',
  detail: msg('Posts each note in a channel, with its link, its capture and its element.'),
  // The logo of Slack, from simple-icons 15.0.0 (CC0-1.0), as `connector-marks.tsx` draws the others.
  mark: {
    box: 24,
    path: 'M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52zM6.313 15.165a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313zM8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834zM8.834 6.313a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312zM18.956 8.834a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.522 2.521h-2.522V8.834zM17.688 8.834a2.528 2.528 0 0 1-2.523 2.521 2.527 2.527 0 0 1-2.52-2.521V2.522A2.527 2.527 0 0 1 15.165 0a2.528 2.528 0 0 1 2.523 2.522v6.312zM15.165 18.956a2.528 2.528 0 0 1 2.523 2.522A2.528 2.528 0 0 1 15.165 24a2.527 2.527 0 0 1-2.52-2.522v-2.522h2.52zM15.165 17.688a2.527 2.527 0 0 1-2.52-2.523 2.526 2.526 0 0 1 2.52-2.52h6.313A2.527 2.527 0 0 1 24 15.165a2.528 2.528 0 0 1-2.522 2.523h-6.313z',
  },
  tokenFields: [
    {
      name: 'url',
      label: msg('Webhook URL'),
      type: 'password',
      placeholder: 'https://hooks.slack.com/services/…',
      hint: msg(
        'From your Slack app: Incoming Webhooks, Add New Webhook, then the channel. Fruitback keeps it encrypted.',
      ),
    },
    {
      name: 'notes',
      label: msg('Notes to post'),
      type: 'select',
      options: [
        { value: 'verified', label: msg('Verified notes only') },
        { value: 'all', label: msg('Every note') },
      ],
      hint: msg(
        'A verified note comes from a member, or from a reviewer the site identified. Anybody can write the others.',
      ),
    },
  ],
  problems: {
    'invalid-webhook': msg(
      'This is not an Incoming Webhook of Slack. Copy it again: it starts with https://hooks.slack.com/services/.',
    ),
    'key-refused': msg('Slack refused this webhook: it was removed, or its app was. Make a new one, then try again.'),
    'key-lacks-access': msg(
      'Slack refused to post in the channel of this webhook. Make a webhook for another channel.',
    ),
  },
  attention: {
    'key-refused': msg(
      'Slack refuses the webhook since {when}: it or its app was removed, and the notes of its sites do not reach Slack. Make a new webhook, disconnect this connector, then connect Slack again with it.',
    ),
    'key-lacks-access': msg(
      'Since {when}, Slack refuses to post in the channel of the webhook: it was archived, or posting there is not allowed. Make a webhook for another channel, then connect Slack again with it.',
    ),
  },
  receives: true,
  sourceLine: (label) => label.replace(/^Slack · /, ''),
};
