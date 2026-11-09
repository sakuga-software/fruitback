# Slack

Post the notes of your sites in a Slack channel. Slack is not a tracker: the notes stay in
Fruitback, where their pins, their threads and their statuses live, and Slack gets a message for each
one, with its link, its capture and its element.

[En français](slack.fr.md)

## What you need

- A Slack workspace where you may add an app.
- The role of owner or admin of the workspace in Fruitback.

## 1. Make an Incoming Webhook

Fruitback posts with an Incoming Webhook of your own: one address that posts in one channel.

1. Open api.slack.com/apps, then « Create New App », « From scratch ». Name it `Fruitback`, and choose
   your Slack workspace.
2. Open « Incoming Webhooks », and turn them on.
3. Press « Add New Webhook », choose the channel, and allow it.
4. Copy the webhook URL. It starts with `https://hooks.slack.com/services/`.

The URL is a secret: anybody who has it posts in your channel. Slack revokes a URL that it finds in a
public place.

## 2. Connect it in Fruitback

1. Open « Connectors », then « New connector », then « Connect Slack ».
2. Paste the webhook URL.
3. Choose the notes to post:
   - Verified notes only, the default: a note of a member of the workspace, or of a reviewer that the
     site identified.
   - Every note: on a site that anybody can write on, every visitor's note goes to the channel too.
4. Press « Connect ».

Fruitback posts one message in the channel to say that it is connected. A webhook that Slack refuses
is not kept. The URL is encrypted with the key of the server (`FRUITBACK_SECRETS_KEY`), and no screen
shows it again. To change the notes to post, disconnect Slack and connect it again.

## 3. Send the notes of a site there

On « Sites », open a site, then its destination, and choose the channel of the Slack connector.

## What a message holds

- The name of the note and its page, as a link that opens the note on its page.
- The text of the note.
- The element: its CSS selector, its component and its source file, when the site exposes them.
- The capture, and a link to each file of the note. These links answer for one hour: the files stay
  in Fruitback, and Slack may stop showing the capture after that hour.
- The name the reporter gave, if any.

## When a note does not reach Slack

The panel of the connector lists the notes that did not arrive, and « Try now » sends one again.
Fruitback tries again by itself while Slack is down or limits the rate.

| What the panel says                  | What to do                                                                                              |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| Slack refuses the webhook            | The webhook or its app was removed. Make a new webhook, disconnect the connector, and connect it again. |
| Slack refuses to post in the channel | The channel was archived, or posting there is not allowed. Make a webhook for another channel.          |
