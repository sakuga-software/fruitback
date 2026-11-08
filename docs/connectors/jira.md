# Jira Cloud

A workspace can send the notes of its sites to Jira Cloud. Each note becomes an issue in the project
you choose for the site, with the files of the note attached. When the issue moves in Jira, its pin
on the page takes the stage of its new status.

[Lire en français](jira.fr.md)

## How it connects

Jira connects by consent at Atlassian: OAuth 2.0 (3LO). Fruitback never asks for an API token.
Atlassian's own page on basic authentication says that an app that collects API tokens does not
comply with its security requirements, and a token reaches everything its person reaches, with no
end date.

With the consent:

- the person who connects chooses the Jira sites the connection reaches, at Atlassian;
- the connection acts with the rights of that person in Jira, and no more;
- the token lasts an hour, and Fruitback refreshes it; it is kept encrypted, and no screen shows it;
- the person removes it in one place: their Atlassian account, « Connected apps ».

Fruitback calls `api.atlassian.com` and `auth.atlassian.com` only.

## What the operator sets up once

On the Cloud this is done. On a server you run, make one app at Atlassian for the whole server:

1. Open the [Atlassian developer console](https://developer.atlassian.com/console/myapps/) and
   create an « OAuth 2.0 integration ».
2. Under « Permissions », add the Jira API, and give it these scopes: `read:jira-work`,
   `write:jira-work` and `read:jira-user`. Fruitback also asks for `offline_access`, which needs no
   setting.
3. Under « Authorization », set the callback URL to `<FRUITBACK_PUBLIC_URL>/auth/jira/callback`.
4. Under « Distribution », turn sharing on, so that the people of your workspaces can consent. The
   app stays off the Marketplace; Atlassian shows a warning on the consent until the app is
   reviewed.
5. Under « Settings », copy the client ID and the secret, and set
   `FRUITBACK_JIRA_OAUTH=<client id>:<client secret>` on the worker.

The worker refuses to start with a value that is not two parts, or without `FRUITBACK_PUBLIC_URL`,
`FRUITBACK_DATABASE_URL` and `FRUITBACK_SECRETS_KEY`. See
[Environment variables](../self-hosting/environment-variables.md).

## Connect a workspace

1. In the console, open « Connectors », then « New connector ».
2. On the card « Jira », press « Connect ». Atlassian asks which site to reach, and for your consent.
3. Back in the console, the connector is named after the site: « Jira · acme ».
4. On the « Sites » screen, open a site, then « Add a destination », and choose a project.

The person who connects needs these rights in each project a site sends to: « Browse projects »,
« Create issues » and « Create attachments ».

## What a note becomes

| In the note                                 | In the issue                                                                  |
| ------------------------------------------- | ----------------------------------------------------------------------------- |
| its first line                              | the summary                                                                   |
| its text, the page, the element, the author | the description                                                               |
| the note itself                             | a code block of JSON at the end of the description, that Fruitback reads back |
| its files                                   | attachments of the issue                                                      |
| its site and its page                       | the labels `fruitback`, `fruitback:<site>` and `fruitback-page-<hash>`        |

The issue type is « Bug » when the project has one, else « Task », else the first type of the project
that is not a sub-task.

A page shows the pins of its 1,000 newest notes in Jira; older ones stay in Jira and are not drawn.

Keep the code block and the labels. A pin is found by the label of its page, and drawn from the code
block. An issue without them is no longer shown on the page.

## The stage of a pin

| The category of the status in Jira                                                  | The stage of the pin |
| ----------------------------------------------------------------------------------- | -------------------- |
| To Do                                                                               | New                  |
| In Progress                                                                         | In progress          |
| Done                                                                                | Done                 |
| Done, resolved as « Won't Do », « Declined », « Duplicate » or « Cannot Reproduce » | Closed               |

A site can give one status another stage, on the statuses page of the site.

The replies of the team in Jira come back under the note, when the site shows replies.

## When the connector needs attention

The console says « Needs attention » on the connector, and the notes of its sites wait in the widget:

- Jira refuses the connection: somebody removed the app from their Atlassian account. Disconnect it,
  then connect Jira again.
- Jira refuses a project: the person who connected lost access to it, or it was archived. Give the
  access back in Jira, or choose another project for the site.
- The connection ended: Atlassian refused to refresh it, for example after a change of password, or
  after 90 days in which nothing used it. Connect Jira again.

A Jira that is slow or down is not a refusal: the note waits in the widget, and goes once Jira
answers.

## Disconnect

« Disconnect » in the panel of the connector removes it from the workspace, and its sites keep their
notes in Fruitback again. The issues already in Jira stay there. Atlassian has no route to revoke the
token for you: remove the app from your Atlassian account, « Connected apps », to end it at once.
