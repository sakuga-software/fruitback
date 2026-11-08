# ClickUp

A workspace can send the notes of its sites to ClickUp. Each note becomes a task in the list you
choose for the site, with the files of the note attached. When the task changes status in ClickUp, its
pin on the page takes the stage of the new status.

[Lire en français](clickup.fr.md)

## How it connects

ClickUp offers two ways, and Fruitback takes both:

- by consent at ClickUp (OAuth), where the operator of the server made a ClickUp app. ClickUp
  recommends it for an app that other people use. The person who connects chooses the ClickUp
  Workspaces it reaches.
- by a personal token, on a server with no ClickUp app. ClickUp offers it for one's own use: the
  token acts as its person, in every Workspace of that person.

Neither expires: ClickUp says that its token of OAuth does not expire for now, and that a personal
token never does. Fruitback keeps the token encrypted, and no screen shows it again. Fruitback calls
`api.clickup.com` only.

## What the operator sets up once

This is needed only for the consent. On the Cloud this is done.

1. In ClickUp, as an owner or an admin of a Workspace, click your avatar, then « Settings », then
   « Apps », and « Create new app ».
2. Give it a name, and the redirect URL `<FRUITBACK_PUBLIC_URL>/auth/clickup/callback`.
3. Copy the client ID and the secret, and set `FRUITBACK_CLICKUP_OAUTH=<client id>:<secret>` on the
   worker.

The worker refuses to start with a value that is not two parts, or without `FRUITBACK_PUBLIC_URL`,
`FRUITBACK_DATABASE_URL` and `FRUITBACK_SECRETS_KEY`. See
[Environment variables](../self-hosting/environment-variables.md).

## Connect a workspace

1. In the console, open « Connectors », then « New connector ».
2. On the card « ClickUp », press « Connect ».
   - With a ClickUp app on the server, ClickUp asks which Workspaces to reach, and for your consent.
     « Use a token » is the other way.
   - Without one, paste a personal token: in ClickUp, your avatar, « Settings », « Apps », then
     « API Token ». It starts with `pk_`.
3. The connector is named after the Workspace of ClickUp: « ClickUp · Acme ».
4. On the « Sites » screen, open a site, then « Add a destination », and choose a list. A list is
   named by its space and its folder: « Product › Web › Bugs ».

## What a note becomes

| In the note                                 | In the task                                                                     |
| ------------------------------------------- | ------------------------------------------------------------------------------- |
| its first line                              | the name                                                                        |
| its text, the page, the element, the author | the description                                                                 |
| the note itself                             | a code block of JSON at the end of the description, that Fruitback reads back   |
| its files                                   | attachments of the task                                                         |
| its site and its page                       | the tags `fruitback` and `fruitback-page-<hash>`, made in the space of the list |

Keep the code block and the tags. A pin is found by the tag of its page, and drawn from the code
block. A task without them is no longer shown on the page. A page shows the pins of its 1,000 newest
notes in ClickUp.

## The stage of a pin

| The type of the status in ClickUp      | The stage of the pin |
| -------------------------------------- | -------------------- |
| Not started (« to do »)                | New                  |
| Active (« in progress », and the like) | In progress          |
| Done, or Closed (« complete »)         | Done                 |

A site can give one status another stage, on the statuses page of the site. The replies of the team in
ClickUp come back under the note, when the site shows replies.

## When the connector needs attention

The console says « Needs attention » on the connector, and the notes of its sites wait in the widget:

- ClickUp refuses the token: the app was removed from the Workspace, or the personal token was
  regenerated. Disconnect it, then connect ClickUp again.
- ClickUp refuses a list: the person who connected lost access to it, or it was deleted. Give the
  access back in ClickUp, or choose another list for the site.

A ClickUp that is slow or down is not a refusal: the note waits in the widget, and goes once ClickUp
answers.

## Disconnect

« Disconnect » in the panel of the connector removes it from the workspace, and its sites keep their
notes in Fruitback again. The tasks already in ClickUp stay there. To end the token at once, remove the
app in ClickUp, or regenerate the personal token.
