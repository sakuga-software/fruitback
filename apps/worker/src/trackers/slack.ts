import type { Note } from '@fruitback/shared';
import { StoreError } from '../store.ts';
import {
  type Http,
  type ReceiverAnswer,
  type ReceiverDelivery,
  TrackerInputRefused,
  TrackerKeyForbidden,
  TrackerKeyRefused,
  type TrackerPlugin,
} from './plugin.ts';

/**
 * The connector Slack (FRU-624): each note, or each verified note, posted in a channel. Slack is no
 * tracker: the notes stay in Fruitback, as for a REST address, and a delivery posts a copy.
 *
 * **By an Incoming Webhook**, not an app with `chat:write`. Read in the documentation of Slack on
 * 2026-11-08 (« Sending messages using incoming webhooks », « Image block », « Formatting message
 * text », « Rate limits »). A webhook is one URL, made by the team in its own Slack app, that posts in
 * the one channel chosen when it was made. An app with OAuth would need one application of Slack for
 * each server of Fruitback, distributed and installed: a self-hosted server has none. The URL is the
 * secret: it is sealed like a token, and no route answers it.
 *
 * **Which notes go** is the setting of the connector, chosen when it is connected (`extra.notes`):
 * `verified`, the default, a note of a member or of a reviewer that the site verified; or `all`. A
 * site that anybody writes on would else post every visitor's note in the channel.
 */

/** The address of an Incoming Webhook, as Slack gives it. Its last part is the secret. */
const WEBHOOK = /^https:\/\/hooks\.slack\.com\/services\/(T[A-Z0-9]{2,20})\/(B[A-Z0-9]{2,20})\/[A-Za-z0-9]{8,64}$/;

/** Which notes a connector posts. */
export const SLACK_NOTES = ['verified', 'all'] as const;
export type SlackNotes = (typeof SLACK_NOTES)[number];

/** The one place of a webhook: the channel it was made for. A site chooses it as a destination. */
export const SLACK_CHANNEL = 'channel';

/** Slack refuses a `text` of a section over 3,000 characters. */
const SECTION_MAX = 2_900;

/** The image types an image block takes (« Image block »: png, jpg, jpeg, gif). */
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif']);

/**
 * The words of Slack that say the webhook is gone or may not post (« Handling errors »): the person
 * makes a new webhook. `channel_is_archived` and `posting_to_general_channel_denied` are a channel that
 * refuses it: the webhook is there, and the channel must change.
 */
const GONE = new Set(['no_service', 'no_service_id', 'no_team', 'team_disabled', 'invalid_token', 'no_active_hooks']);
const CHANNEL_REFUSED = new Set([
  'channel_not_found',
  'channel_is_archived',
  'action_prohibited',
  'posting_to_general_channel_denied',
  'user_not_found',
]);

/** The webhook of a value, or `undefined` for one that is not an Incoming Webhook of Slack. */
export function readWebhook(value: unknown): { url: string; label: string } | undefined {
  if (typeof value !== 'string') return undefined;
  const url = value.trim();
  const found = WEBHOOK.exec(url);

  return found === null ? undefined : { url, label: `Slack · ${found[1]}/${found[2]}` };
}

/** `&`, `<` and `>` are the control characters of Slack's text (« Escaping text »). */
export function escapeSlack(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** A link of Slack: a `|` or a `>` in the address would end it. */
function link(url: string, label: string): string {
  return `<${url.replace(/[|>\s]/g, encodeURIComponent)}|${escapeSlack(label).replace(/\|/g, '¦')}>`;
}

/** Whether a connector with this setting posts this note. */
export function slackTakes(note: Pick<Note, 'reporter'>, notes: string | undefined): boolean {
  return notes === 'all' || note.reporter?.verified === true;
}

/** The address that opens the note on its page (`#fruitback-note=`, the link of the console). */
export function noteLink(note: Note): string {
  const page = new URL(note.page.url);
  page.hash = `fruitback-note=${encodeURIComponent(note.id)}`;

  return page.toString();
}

/** The message of one note: a text for the notification, and its blocks. */
export function slackMessage(delivery: ReceiverDelivery): { text: string; blocks: unknown[] } {
  const { note, identifier } = delivery;
  const page = note.page.title?.trim() || note.page.path || note.page.url;
  const words = note.text.length > SECTION_MAX ? `${note.text.slice(0, SECTION_MAX)}…` : note.text;
  const element = [
    note.anchor?.selector === undefined ? undefined : `\`${escapeSlack(note.anchor.selector.replace(/`/g, "'"))}\``,
    note.source?.component === undefined ? undefined : escapeSlack(note.source.component),
    note.source?.file === undefined
      ? undefined
      : escapeSlack(`${note.source.file}${note.source.line === undefined ? '' : `:${note.source.line}`}`),
  ].filter((each): each is string => each !== undefined);
  const files = delivery.attachments ?? [];
  const image = files.find((file) => IMAGE_TYPES.has(file.type));
  const by = note.reporter?.name?.trim();

  return {
    // The text of the notification is read as mrkdwn too: a `<!channel>` a visitor writes stays words
    // (review of #871).
    text: escapeSlack(`${identifier}: ${note.text.slice(0, 200)}`),
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*${link(noteLink(note), `${identifier} · ${page}`)}*\n${escapeSlack(words)}`,
        },
      },
      ...(element.length === 0 ? [] : [{ type: 'context', elements: [{ type: 'mrkdwn', text: element.join(' · ') }] }]),
      ...(image === undefined ? [] : [{ type: 'image', image_url: image.url, alt_text: image.name.slice(0, 200) }]),
      ...(files.length === 0
        ? []
        : [
            {
              type: 'context',
              elements: [
                {
                  type: 'mrkdwn',
                  // The address of a file answers for one hour: the note keeps its files in Fruitback.
                  text: files.map((file) => link(file.url, file.name)).join(' · '),
                },
              ],
            },
          ]),
      ...(by === undefined || by === ''
        ? []
        : [{ type: 'context', elements: [{ type: 'mrkdwn', text: escapeSlack(by.slice(0, 200)) }] }]),
    ],
  };
}

/** One post on the webhook, and what Slack said of it. */
async function post(http: Http, url: string, message: unknown): Promise<ReceiverAnswer> {
  let response: Response;
  try {
    response = await http(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(message),
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return { ok: false, error: 'Slack could not be reached', retry: true };
  }
  const word = (await response.text().catch(() => '')).trim().slice(0, 100);
  if (response.ok) return { ok: true };
  if (GONE.has(word)) throw new TrackerKeyRefused(`Slack refused the webhook: ${word}`);
  if (CHANNEL_REFUSED.has(word)) throw new TrackerKeyForbidden(`Slack refused the channel: ${word}`);
  // A message Slack cannot read is refused the same way at every attempt.
  const final = response.status === 400;

  return { ok: false, status: response.status, error: `Slack answered ${word || response.status}`, retry: !final };
}

export const plugin: TrackerPlugin | undefined = {
  kind: 'slack',
  name: 'Slack',
  async connect(body, { http }) {
    const webhook = readWebhook(body.url);
    if (webhook === undefined) throw new TrackerInputRefused('invalid-webhook');
    const notes = body.notes === undefined || body.notes === '' ? 'verified' : body.notes;
    if (typeof notes !== 'string' || !(SLACK_NOTES as readonly string[]).includes(notes)) {
      throw new TrackerInputRefused('invalid-setting');
    }
    // A webhook says whether it works only by posting: the channel reads that it is connected, and a
    // webhook Slack refuses is never kept.
    const said = await post(http, webhook.url, {
      text:
        notes === 'all'
          ? 'Fruitback is connected: each note of the sites that send here will be posted in this channel.'
          : 'Fruitback is connected: each verified note of the sites that send here will be posted in this channel.',
    });
    if (!said.ok) throw new StoreError(said.error);

    return { label: webhook.label, token: webhook.url, extra: { notes } };
  },
  places: async () => ({ places: [{ id: SLACK_CHANNEL, name: 'channel' }] }),
  readPlace: (value) => (value === SLACK_CHANNEL ? SLACK_CHANNEL : undefined),
  placeName: async (_access, place) => (place === SLACK_CHANNEL ? { name: 'channel' } : undefined),
  store() {
    throw new StoreError('Slack keeps no note: its connector receives them');
  },
  receiver: {
    takes: (note, credential) => slackTakes(note, credential.extra.notes),
    async deliver(access, delivery) {
      const credential = await access.credential();
      if (credential.via !== 'token' || readWebhook(credential.token) === undefined) {
        throw new StoreError('The webhook of this Slack connector could not be opened');
      }

      return post(access.http, credential.token, slackMessage(delivery));
    },
  },
};
