/** The French of the connector Slack (FRU-624) (`slack.ts`), merged into `messages.fr.ts`. */
export const FRENCH: Readonly<Record<string, string>> = {
  'Posts each note in a channel, with its link, its capture and its element.':
    'Publie chaque note dans un canal, avec son lien, sa capture et son élément.',
  'Webhook URL': 'URL du webhook',
  'From your Slack app: Incoming Webhooks, Add New Webhook, then the channel. Fruitback keeps it encrypted.':
    'Depuis votre app Slack : Incoming Webhooks, Add New Webhook, puis le canal. Fruitback la garde chiffrée.',
  'Notes to post': 'Notes à publier',
  'Verified notes only': 'Les notes vérifiées seulement',
  'Every note': 'Toutes les notes',
  'A verified note comes from a member, or from a reviewer the site identified. Anybody can write the others.':
    'Une note vérifiée vient d’un membre, ou d’un relecteur que le site a identifié. N’importe qui peut écrire les autres.',
  'This is not an Incoming Webhook of Slack. Copy it again: it starts with https://hooks.slack.com/services/.':
    'Ce n’est pas un Incoming Webhook de Slack. Copiez-le de nouveau : il commence par https://hooks.slack.com/services/.',
  'Slack refused this webhook: it was removed, or its app was. Make a new one, then try again.':
    'Slack a refusé ce webhook : il a été supprimé, ou son app l’a été. Créez-en un nouveau, puis réessayez.',
  'Slack refused to post in the channel of this webhook. Make a webhook for another channel.':
    'Slack a refusé de publier dans le canal de ce webhook. Créez un webhook pour un autre canal.',
  'Slack refuses the webhook since {when}: it or its app was removed, and the notes of its sites do not reach Slack. Make a new webhook, disconnect this connector, then connect Slack again with it.':
    'Slack refuse le webhook depuis {when} : lui ou son app a été supprimé, et les notes de ses sites n’arrivent pas dans Slack. Créez un nouveau webhook, déconnectez ce connecteur, puis connectez Slack de nouveau avec lui.',
  'Since {when}, Slack refuses to post in the channel of the webhook: it was archived, or posting there is not allowed. Make a webhook for another channel, then connect Slack again with it.':
    'Depuis {when}, Slack refuse de publier dans le canal du webhook : il a été archivé, ou la publication y est interdite. Créez un webhook pour un autre canal, puis connectez Slack de nouveau avec lui.',
  '{source} did not take it: {error}': '{source} ne l’a pas pris : {error}',
};
