# Asana

A workspace can send the notes of its sites to Asana. Each note becomes a task in the project you
choose for the site, with the files of the note attached. When the task is completed in Asana, or
moves to another section, its pin on the page takes the stage of that state.

[Lire en français](asana.fr.md)

## How it connects

Asana offers two ways, and Fruitback takes both:

- by consent at Asana (OAuth), where the operator of the server made an Asana app. Asana recommends
  it for an app that acts for other people. The token lasts an hour, and Fruitback refreshes it.
- by a personal access token, on a server with no Asana app. The token acts as its person, in every
  workspace of that person, until it is revoked.

Fruitback keeps the token encrypted, and no screen shows it again. Fruitback calls `app.asana.com`
only.

## What the operator sets up once

This is needed only for the consent. On the Cloud this is done.

1. Open the [Asana developer console](https://app.asana.com/0/my-apps), and create a new app.
2. Under « OAuth », add the redirect URL `<FRUITBACK_PUBLIC_URL>/auth/asana/callback`, and choose
   « Full permissions »: Fruitback asks for no scope of its own.
3. Copy the client ID and the client secret, and set `FRUITBACK_ASANA_OAUTH=<client id>:<secret>` on
   the worker.

The worker refuses to start with a value that is not two parts, or without `FRUITBACK_PUBLIC_URL`,
`FRUITBACK_DATABASE_URL` and `FRUITBACK_SECRETS_KEY`. See
[Environment variables](../self-hosting/environment-variables.md).

## Connect a workspace

1. In the console, open « Connectors », then « New connector ».
2. On the card « Asana », press « Connect ».
   - With an Asana app on the server, Asana asks for your consent. « Use a token » is the other way.
   - Without one, paste a personal access token, made in the
     [developer console](https://app.asana.com/0/my-apps) of Asana.
3. The connector is named after the Asana workspace: « Asana · Acme ».
4. On the « Sites » screen, open a site, then « Add a destination », and choose a project.

## What a note becomes

| In the note                                 | In the task                                                             |
| ------------------------------------------- | ----------------------------------------------------------------------- |
| its first line                              | the name                                                                |
| its text, the page, the element, the author | the notes (the description)                                             |
| the note itself                             | a code block of JSON at the end of the notes, that Fruitback reads back |
| its files                                   | attachments of the task                                                 |
| its project, its site and its page          | the tag `fruitback-page-<hash>`, made in the workspace of the project   |

Keep the code block and the tag. A pin is found by the tag of its project, its site and its page, and drawn from
the code block. A task without them is no longer shown on the page. A page shows the pins of its
1,000 newest notes in Asana.

## The stage of a pin

| The task in Asana          | The stage of the pin                          |
| -------------------------- | --------------------------------------------- |
| completed                  | Done                                          |
| in a section, not complete | New, or the stage the site gives that section |

Asana says nothing of what a section means, so each section is New until a site gives it a stage, on
the statuses page of the site: « Doing » can be In progress, for example. The comments of the team in
Asana come back under the note, when the site shows replies.

## When the connector needs attention

The console says « Needs attention » on the connector, and the notes of its sites wait in the widget:

- Asana refuses the token: the app was deauthorized, or the personal access token was revoked.
  Disconnect it, then connect Asana again.
- Asana refuses a project: the person who connected lost access to it, or it was deleted. Give the
  access back in Asana, or choose another project for the site.
- The connection ended: Asana refused to refresh it. Connect Asana again.

An Asana that is slow or down is not a refusal: the note waits in the widget, and goes once Asana
answers.

## Disconnect

« Disconnect » in the panel of the connector removes it from the workspace, and its sites keep their
notes in Fruitback again. A connection made by consent is revoked at Asana at the same time. The tasks
already in Asana stay there. A personal access token stays valid until you revoke it in the developer
console.
